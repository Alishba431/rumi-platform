/**
 * The guided debrief — the worker side (processDebriefRecording).
 *
 * Download the recording via the channel facade → transcribe → too-short
 * guard → coach-the-coach feedback (one guided repair, the harm gate and the
 * score block still enforced in code) → deliver (praise bubble + the card as
 * an image, falling back to the text card on any image failure) → flip
 * debrief_status to 'done' → merge into analysis_data.observer_debrief (never
 * clobber) → offer to send the teacher their report.
 *
 * Failures keep the debrief 'pending' (it resurfaces in /observe): a
 * transcription failure is recorded on the row for the retry sweep and the
 * coach is told ONCE; redelivery is idempotent (done → no-op; stored feedback
 * → deliver only).
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
const { createFakeSupabase } = require('./_helpers/fake-supabase');
const mockDb = createFakeSupabase({ coaching_sessions: [], users: [], observation_schedules: [] });
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);

const mockRedis = new Map();
jest.mock('../../bot/shared/services/cache/railway-redis.service', () => ({
  setexWithCeiling: jest.fn(async (k, _ttl, v) => { mockRedis.set(k, v); return true; }),
  get: jest.fn(async (k) => { const v = mockRedis.get(k); if (v === undefined) return null; try { return JSON.parse(v); } catch (_) { return v; } }),
  delete: jest.fn(async (k) => { mockRedis.delete(k); return true; }),
}));
const mockImagePaths = [];
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true),
  sendImage: jest.fn(async (_to, p) => { mockImagePaths.push([p, require('fs').existsSync(p)]); return true; }),
  sendInteractiveButtons: jest.fn(async () => true),
  downloadMedia: jest.fn(async () => Buffer.from('debrief-audio-bytes')),
}));
const mockComplete = jest.fn();
jest.mock('../../bot/shared/services/gpt5-mini.service', () => ({ completeJson: (...a) => mockComplete(...a) }));
const mockTranscribe = jest.fn();
jest.mock('../../bot/shared/services/coaching/transcription-processor.service', () => ({
  transcribeWithDiarization: (...a) => mockTranscribe(...a),
}));
const mockHtmlToImage = jest.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
jest.mock('../../bot/shared/utils/html-to-pdf', () => ({ htmlToImage: (...a) => mockHtmlToImage(...a) }));
const mockOfferSend = jest.fn(async () => true);
jest.mock('../../bot/shared/services/observe/observe-send.service', () => ({ offerSendReport: (...a) => mockOfferSend(...a) }));

const fs = require('fs');
const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const ObserveDebrief = require('../../bot/shared/services/observe/observe-debrief.service');
const ObserveState = require('../../bot/shared/services/observe/observe-state.service');
const { observeStrings } = require('../../bot/shared/services/observe/observe-strings');

const S = observeStrings('en');
const COACH = { id: 'coach-1', name: 'Sam Rivera', role: 'coach', preferred_language: 'en', phone_number: '15550100001' };
const TEACHER = { id: 'teacher-1', name: 'Robin Park', preferred_language: 'en', phone_number: '15550100009' };

const LONG_TRANSCRIPT = 'Teacher: Thank you for having me today. I loved how you used the counting sticks with the groups. '
  + 'Student: Thank you. I felt the children were with me most of the time. Teacher: What will you try on Monday? '
  + 'Student: I will ask two children to explain the answer before I move on.';

const rubric = (over = {}) => ({
  opened_with_specific_praise: true, anchored_in_real_moment: true, asked_and_waited: false,
  one_improvement_only: true, moves_not_teacher: true, elicited_if_then: true,
  righting_reflex_held: true, disparaged_teacher: false, ...over,
});
const healthy = () => ({
  praise_line: 'You opened with a real, specific strength.',
  wins: [
    { behaviour: 'Praise with evidence', evidence: 'I loved how you used the counting sticks with the groups.' },
    { behaviour: 'Their own commitment', evidence: 'What will you try on Monday?' },
  ],
  try: { move: 'Hold the silence', evidence: 'You moved on quickly after your question.', instead: 'Count to five before speaking.' },
  reflection_question: 'What does a silence give the teacher?',
  value: 'listening',
  rubric: rubric(),
});
const harmful = () => ({
  praise_line: null,
  wins: [],
  concern: { what_happened: 'You called the lesson useless.', why_it_matters: 'It costs the teacher\'s trust.', instead: 'Describe one moment instead.' },
  try: { move: 'Talk about the moves', evidence: '"This lesson was useless."', instead: 'Ask what they noticed.' },
  reflection_question: 'What did the teacher need from you?',
  value: null,
  rubric: rubric({ disparaged_teacher: true, moves_not_teacher: false }),
});

function seed(over = {}, debrief = {}) {
  const row = {
    id: 'obs-1', user_id: TEACHER.id, observer_user_id: COACH.id, observation_type: 'leader_observation',
    status: 'observer_review_complete', debrief_status: 'pending', created_at: '2026-09-01T09:00:00Z',
    analysis_data: {
      strengths: [{ evidence: 'lesson evidence stays' }],
      teacher_delivery: null,
      observer_debrief: { audio_id: 'media-9', audio_mime: 'audio/aac', guide_snapshot: { steps: [] }, attempts: 0, ...debrief },
    },
    ...over,
  };
  mockDb.tables.coaching_sessions.push(row);
  return row;
}
const row = (id = 'obs-1') => mockDb.tables.coaching_sessions.find((r) => r.id === id);
const sent = () => WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.clear();
  mockImagePaths.length = 0;
  mockDb.tables.coaching_sessions.length = 0;
  mockDb.tables.users.length = 0;
  mockDb.tables.users.push({ ...COACH }, { ...TEACHER });
  mockTranscribe.mockResolvedValue({ transcript: LONG_TRANSCRIPT, language: 'en', diarization: { confidence: 80, segments: [] } });
  mockComplete.mockResolvedValue({ result: healthy(), usage: {} });
});

describe('processDebriefRecording — the happy path', () => {
  test('transcribes, coaches, delivers praise + card image, flips done, merges, offers the send', async () => {
    seed();
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001', audioId: 'media-9' });

    expect(WhatsAppService.downloadMedia).toHaveBeenCalledWith('media-9');
    const [audioPath] = mockTranscribe.mock.calls[0];
    expect(audioPath).toMatch(/observe_debrief_obs-1_\d+\.aac$/);   // the real container, not always .ogg
    expect(fs.existsSync(audioPath)).toBe(false);                   // temp file cleaned up

    const [prompt, opts] = mockComplete.mock.calls[0];
    expect(prompt).toContain(LONG_TRANSCRIPT);
    expect(prompt).toContain('Sam Rivera');          // the COACH's name, not the teacher's
    expect(opts.label).toBe('observeCoachFeedback');

    expect(sent()[0]).toBe(healthy().praise_line);
    const [to, pngPath, caption] = WhatsAppService.sendImage.mock.calls[0];
    expect(to).toBe('15550100001');
    expect(pngPath).toMatch(/\.png$/);
    expect(mockImagePaths[0][1]).toBe(true);          // the PNG existed when sent…
    expect(fs.existsSync(pngPath)).toBe(false);       // …and is removed afterwards
    expect(caption).toBe(S.coach_card_closing);

    const r = row();
    expect(r.debrief_status).toBe('done');
    expect(r.analysis_data.strengths).toEqual([{ evidence: 'lesson evidence stays' }]);
    expect(r.analysis_data.observer_debrief).toMatchObject({
      audio_id: 'media-9', transcript: LONG_TRANSCRIPT, transcript_language: 'en', diarization_confidence: 80,
    });
    expect(r.analysis_data.observer_debrief.feedback.wins).toHaveLength(2);
    expect(r.analysis_data.observer_debrief.completed_at).toBeTruthy();
    expect(r.analysis_data.observer_debrief.audio_hash).toMatch(/^[0-9a-f]{64}$/);

    expect(mockOfferSend).toHaveBeenCalledWith(expect.objectContaining({ id: COACH.id }), '15550100001', 'obs-1');
  });

  test('no `from` in the payload: delivers to the COACH, never the bound teacher', async () => {
    seed();
    await ObserveDebrief.processDebriefRecording('obs-1', {});
    expect(WhatsAppService.sendMessage.mock.calls[0][0]).toBe(COACH.phone_number);
    expect(mockOfferSend.mock.calls[0][1]).toBe(COACH.phone_number);
  });

  test('a card render failure falls back to the text card', async () => {
    seed();
    mockHtmlToImage.mockRejectedValueOnce(new Error('no browser'));
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(WhatsAppService.sendImage).not.toHaveBeenCalled();
    expect(sent()[1]).toContain('✓');
    expect(row().debrief_status).toBe('done');
  });

  test('an image send that fails (false or a throw) falls back to the text card', async () => {
    seed();
    WhatsAppService.sendImage.mockResolvedValueOnce(false);
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(sent()[1]).toContain(S.coach_card_wins_label);

    mockDb.tables.coaching_sessions.length = 0;
    WhatsAppService.sendMessage.mockClear();
    seed();
    WhatsAppService.sendImage.mockRejectedValueOnce(new Error('upload failed'));
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(sent()[1]).toContain(S.coach_card_wins_label);
    expect(row().debrief_status).toBe('done');
  });

  test('a harmful debrief: no card image, the honest concern, never a win', async () => {
    seed();
    mockComplete.mockResolvedValueOnce({ result: harmful(), usage: {} });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(mockHtmlToImage).not.toHaveBeenCalled();
    expect(WhatsAppService.sendImage).not.toHaveBeenCalled();
    expect(sent()[0]).toBe(S.coach_concern_opener);
    expect(sent().join('\n')).not.toMatch(/✓/);
    expect(sent()[1]).toContain('You called the lesson useless.');
  });

  test('a silently failed text send keeps it pending and throws for the queue retry', async () => {
    seed();
    WhatsAppService.sendMessage.mockResolvedValueOnce(false);
    await expect(ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' })).rejects.toThrow(/send failed/);
    expect(row().debrief_status).toBe('pending');
    expect(row().analysis_data.observer_debrief.feedback).toBeTruthy();   // persisted → the retry is deliver-only
  });
});

describe('processDebriefRecording — a deliver-only retry', () => {
  test('the card send fails once: the retry sends the card, never the opening a second time', async () => {
    seed();
    WhatsAppService.sendImage.mockResolvedValueOnce(false);                       // card image fails…
    WhatsAppService.sendMessage.mockResolvedValueOnce(true).mockResolvedValueOnce(false);   // …and so does the text card
    await expect(ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' })).rejects.toThrow(/send failed/);
    expect(row().debrief_status).toBe('pending');
    expect(row().analysis_data.observer_debrief.opening_sent_at).toBeTruthy();

    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });   // the queue's retry
    expect(sent().filter((m) => m === healthy().praise_line)).toHaveLength(1);
    expect(WhatsAppService.sendImage).toHaveBeenCalledTimes(2);
    expect(row().debrief_status).toBe('done');
  });

  test('a failed opening is not marked sent, so the retry sends it', async () => {
    seed();
    WhatsAppService.sendMessage.mockResolvedValueOnce(false);
    await expect(ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' })).rejects.toThrow(/send failed/);
    expect(row().analysis_data.observer_debrief.opening_sent_at).toBeFalsy();
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(sent().filter((m) => m === healthy().praise_line)).toHaveLength(2);
    expect(row().debrief_status).toBe('done');
  });
});

describe('processDebriefRecording — validation and repair', () => {
  test('one guided repair: the validator error is fed back, the corrected answer is used', async () => {
    seed();
    const bad = healthy();
    bad.wins = [bad.wins[0]];
    mockComplete.mockResolvedValueOnce({ result: bad, usage: {} }).mockResolvedValueOnce({ result: healthy(), usage: {} });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(mockComplete.mock.calls[1][0]).toMatch(/rejected by a strict validator[\s\S]*exactly 2 wins/);
    expect(mockComplete.mock.calls[1][1].label).toBe('observeCoachFeedbackRepair');
    expect(row().debrief_status).toBe('done');
  });

  test('a score that survives the repair never reaches the coach', async () => {
    seed();
    const scored = healthy();
    scored.praise_line = 'You did 6/8 of the moves — 75%!';
    mockComplete.mockResolvedValue({ result: scored, usage: {} });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(sent()).toEqual([S.debrief_feedback_failed]);
    expect(sent().join('\n')).not.toMatch(/6\/8|75%/);
    expect(row().debrief_status).toBe('pending');
    expect(row().analysis_data.observer_debrief.transcript).toBe(LONG_TRANSCRIPT);   // the recording is not lost
  });

  test('praise for a harmful debrief that survives the repair is never delivered', async () => {
    seed();
    const manufactured = { ...healthy(), rubric: rubric({ disparaged_teacher: true }) };
    mockComplete.mockResolvedValue({ result: manufactured, usage: {} });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(sent()).toEqual([S.debrief_feedback_failed]);
  });
});

describe('processDebriefRecording — guards and failures', () => {
  test('too short: re-arms the recording state and says so; stays pending', async () => {
    seed();
    mockTranscribe.mockResolvedValueOnce({ transcript: 'Hello. Thanks.', diarization: {} });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(sent()).toEqual([S.debrief_too_short]);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(row().debrief_status).toBe('pending');
    const st = await ObserveState.getState(COACH.id);
    expect(st).toMatchObject({ state: 'awaiting_debrief_audio', sessionId: 'obs-1' });
  });

  test('a transcription failure is recorded for the sweep and told ONCE; never thrown', async () => {
    seed();
    mockTranscribe.mockRejectedValue(new Error('provider balance exhausted'));
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    let od = row().analysis_data.observer_debrief;
    expect(od).toMatchObject({ attempts: 1, error_class: 'transient' });
    expect(od.failure_notified_at).toBeTruthy();
    expect(sent()).toEqual([S.debrief_processing_failed]);

    WhatsAppService.sendMessage.mockClear();
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    od = row().analysis_data.observer_debrief;
    expect(od.attempts).toBe(2);
    expect(sent()).toEqual([]);   // told once only
    expect(row().debrief_status).toBe('pending');
  });

  test('a dead media id is classed media_gone and the coach is asked to re-record', async () => {
    seed();
    const err = Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404 }, config: { url: 'https://graph.facebook.com/v19.0/media-9' },
    });
    WhatsAppService.downloadMedia.mockRejectedValueOnce(err);
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(row().analysis_data.observer_debrief.error_class).toBe('media_gone');
    expect(sent()).toEqual([S.debrief_media_gone]);
  });

  test('redelivery: done is a no-op; stored feedback is deliver-only', async () => {
    seed({ debrief_status: 'done' });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();

    mockDb.tables.coaching_sessions.length = 0;
    seed({}, { transcript: LONG_TRANSCRIPT, feedback: healthy() });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
    expect(sent()[0]).toBe(healthy().praise_line);
    expect(row().debrief_status).toBe('done');
  });

  test('a stored transcript is not re-transcribed', async () => {
    seed({}, { transcript: LONG_TRANSCRIPT });
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(WhatsAppService.downloadMedia).not.toHaveBeenCalled();
    expect(row().debrief_status).toBe('done');
  });

  test('no audio id anywhere is an error', async () => {
    seed({}, { audio_id: null });
    await expect(ObserveDebrief.processDebriefRecording('obs-1', {})).rejects.toThrow(/no audio id/);
  });

  test('the same bytes already coached for another observation: refused, detached, re-armed', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(Buffer.from('debrief-audio-bytes')).digest('hex');
    seed({ id: 'obs-0', debrief_status: 'done' }, { audio_hash: hash, feedback: healthy() });
    seed();
    await ObserveDebrief.processDebriefRecording('obs-1', { from: '15550100001' });
    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(sent()).toEqual([S.debrief_duplicate_recording]);
    expect(row('obs-1').analysis_data.observer_debrief).toMatchObject({ audio_id: null, duplicate_of_session_id: 'obs-0' });
    expect((await ObserveState.getState(COACH.id)).sessionId).toBe('obs-1');
  });
});

describe('tempExtensionFor', () => {
  test.each([
    ['audio/aac', '.aac'], ['audio/mp4', '.m4a'], ['audio/mpeg', '.mp3'], ['audio/ogg; codecs=opus', '.ogg'],
    ['audio/wav', '.wav'], [null, '.ogg'], ['application/octet-stream', '.ogg'],
  ])('%s → %s', (mime, ext) => {
    expect(ObserveDebrief.tempExtensionFor(mime)).toBe(ext);
  });
});
