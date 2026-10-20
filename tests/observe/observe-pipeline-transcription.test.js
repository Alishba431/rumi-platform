/**
 * The transcription step on a leader observation.
 *
 * The coaching pipeline was built for a teacher's own recording: it greets
 * them, may switch THEIR language to the lesson's, reminds them of a prior
 * commitment and asks for a classroom photo. On an observation the person in
 * the chat is the COACH and the row's user is the TEACHER, so every one of
 * those is wrong. The observation is read from the row (observation_type),
 * never from the job payload, and goes straight on to analysis.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', phone_number: '15550100001', first_name: 'Robin' },
    { id: 't-1', phone_number: '15550100002', first_name: 'Sam', preferred_language: 'en' },
  ],
  coaching_sessions: [
    { id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'confirmed', audio_duration_seconds: 1500 },
    { id: 'dc-1', user_id: 't-1', observer_user_id: null, observation_type: null, status: 'confirmed', audio_duration_seconds: 1500 },
  ],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  downloadMedia: jest.fn(async () => Buffer.from('audio-bytes')),
  sendMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendVideo: jest.fn(async () => true),
  sendImage: jest.fn(async () => true),
  sendSticker: jest.fn(async () => true),
}));
const mockR2 = { configured: true };
jest.mock('../../bot/shared/storage/r2', () => ({
  isR2Configured: () => mockR2.configured,
  uploadClassroomAudio: jest.fn(async () => { if (!mockR2.configured) throw new Error('S3Client cannot be constructed'); return 'r2://audio'; }),
}));
const mockLang = { getUserLanguage: jest.fn(async () => 'en'), setUserLanguage: jest.fn(async () => true) };
jest.mock('../../bot/shared/utils/language-cache', () => mockLang);
jest.mock('../../bot/shared/utils/language-detector', () => ({
  analyzeLanguage: () => ({ shouldUpdate: true, newLanguage: 'sw', reason: 'lesson language', details: { confidence: 0.9 } }),
}));
const mockQueue = { queueCoachingJob: jest.fn(async () => 'm1') };
jest.mock('../../bot/shared/services/queue', () => mockQueue);
jest.mock('../../bot/shared/services/coaching/coaching-helpers.service', () => ({ generateEncouragingMessage: jest.fn(async () => 'Great lesson!') }));

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const TranscriptionProcessor = require('../../bot/shared/services/coaching/transcription-processor.service');

// Soniox is the network boundary: its wrapper returns a fixed transcript.
const TRANSCRIPT = { transcript: 'T: Good morning.', language: 'en', diarization: { speakers: ['T'], confidence: 0.9 }, tokens: [], silences: [], cost: 0.01 };

describe('transcription on a leader observation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(TranscriptionProcessor, 'transcribeWithDiarization').mockResolvedValue(TRANSCRIPT);
    jest.spyOn(TranscriptionProcessor, 'sendProgressUpdate').mockResolvedValue();
  });

  test('queues analysis directly: no progress animation, no language switch, nothing sent to the coach', async () => {
    await TranscriptionProcessor.processTranscription('obs-1', { from: '15550100001', audioId: 'media-1' });
    const row = mockDb.tables.coaching_sessions.find((s) => s.id === 'obs-1');
    expect(row).toMatchObject({ transcript_text: 'T: Good morning.', status: 'transcription_complete' });
    expect(mockQueue.queueCoachingJob).toHaveBeenCalledWith('obs-1', 'analysis', { from: '15550100001' });
    expect(TranscriptionProcessor.sendProgressUpdate).not.toHaveBeenCalled();
    expect(mockLang.setUserLanguage).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(WhatsAppService.sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('a teacher\'s own recording is unchanged: progress, language update, encouragement, photo prompt', async () => {
    await TranscriptionProcessor.processTranscription('dc-1', { from: '15550100002', audioId: 'media-2' });
    expect(TranscriptionProcessor.sendProgressUpdate).toHaveBeenCalledWith('15550100002', 1);
    expect(mockLang.setUserLanguage).toHaveBeenCalledWith('t-1', 'sw');
    expect(WhatsAppService.sendMessage).toHaveBeenCalledWith('15550100002', 'Great lesson!');
    expect(WhatsAppService.sendInteractiveButtons).toHaveBeenCalled();
    expect(mockQueue.queueCoachingJob).not.toHaveBeenCalledWith('dc-1', 'analysis', expect.anything());
  });

  test('without object storage (R2 is optional) the recording is still transcribed and analysed', async () => {
    mockR2.configured = false;
    const row = mockDb.tables.coaching_sessions.find((x) => x.id === 'obs-1');
    row.status = 'confirmed';
    await TranscriptionProcessor.processTranscription('obs-1', { from: '15550100001', audioId: 'media-1' });
    mockR2.configured = true;
    expect(row).toMatchObject({ status: 'transcription_complete', audio_url: null });
    expect(mockQueue.queueCoachingJob).toHaveBeenCalledWith('obs-1', 'analysis', { from: '15550100001' });
  });
});
