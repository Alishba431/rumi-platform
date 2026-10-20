/**
 * The analysis step on a leader observation: the rubric is the observe pack
 * (never the coach's or teacher's own framework), no teacher-facing progress
 * messages or reflective chat, no prior-feedback from the teacher's own
 * sessions, and the result goes to the coach as the draft to review. A
 * teacher's own recording keeps the existing path.
 */

const { createFakeSupabase } = require('./_helpers/fake-supabase');

const mockDb = createFakeSupabase({
  users: [
    { id: 'coach-1', role: 'coach', phone_number: 'mtx:15550100001', first_name: 'Robin', last_name: 'Coach' },
    { id: 't-1', phone_number: 'mtx:15550100002', first_name: 'Sam', last_name: 'Taylor', preferred_language: 'en' },
  ],
  coaching_sessions: [
    { id: 'obs-1', user_id: 't-1', observer_user_id: 'coach-1', observation_type: 'leader_observation', status: 'transcription_complete', transcript_text: 'T: Good morning.', audio_duration_seconds: 1500 },
    { id: 'dc-1', user_id: 't-1', observer_user_id: null, observation_type: null, status: 'transcription_complete', transcript_text: 'T: Hello.', audio_duration_seconds: 1500 },
  ],
});
jest.mock('../../bot/shared/config/supabase', () => mockDb.client);
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true), sendVideo: jest.fn(async () => true), sendImage: jest.fn(async () => true), sendSticker: jest.fn(async () => true),
}));
const mockGpt = {
  analyzePedagogy: jest.fn(async () => ({ analysis: { domains: {}, summary: 'ok' }, usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost: 0.01 } })),
  extractReflectiveCorpus: jest.fn(async () => ({ corpus: { c: 1 }, model_used: 'm' })),
};
jest.mock('../../bot/shared/services/gpt5-mini.service', () => mockGpt);
const mockSelector = { selectFramework: jest.fn(async () => ({ name: 'oecd' })) };
jest.mock('../../bot/shared/services/coaching/frameworks/framework-selector', () => mockSelector);
jest.mock('../../bot/shared/services/coaching/report-generator.service', () => ({
  fetchAndCompressPriorFeedback: jest.fn(async () => ({ exists: false })),
}));
const mockReflective = { conductReflectiveConversation: jest.fn(async () => true) };
jest.mock('../../bot/shared/services/coaching/reflective-conversation.service', () => mockReflective);
const mockDraft = { onAnalysisReady: jest.fn(async () => true) };
jest.mock('../../bot/shared/services/observe/observe-draft.service', () => mockDraft);

const WhatsAppService = require('../../bot/shared/services/whatsapp.service');
const ReportGenerator = require('../../bot/shared/services/coaching/report-generator.service');
const AnalysisProcessor = require('../../bot/shared/services/coaching/analysis-processor.service');

describe('analysis on a leader observation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AnalysisProcessor, 'sendProgressUpdate').mockResolvedValue();
  });

  test('uses the observe pack, skips the teacher-facing steps, hands the draft to the coach', async () => {
    await AnalysisProcessor.processAnalysis('obs-1', { from: 'mtx:15550100001' });
    const [, metadata, , framework] = mockGpt.analyzePedagogy.mock.calls[0];
    expect(framework.name).toBe('teach');
    expect(framework.version).toBe('observe-1.0');
    expect(metadata.teacherName).toBe('Sam');
    expect(metadata.priorFeedback).toBeNull();
    expect(mockSelector.selectFramework).not.toHaveBeenCalled();
    expect(ReportGenerator.fetchAndCompressPriorFeedback).not.toHaveBeenCalled();
    expect(mockGpt.extractReflectiveCorpus).not.toHaveBeenCalled();
    expect(AnalysisProcessor.sendProgressUpdate).not.toHaveBeenCalled();
    expect(WhatsAppService.sendMessage).not.toHaveBeenCalled();
    expect(mockReflective.conductReflectiveConversation).not.toHaveBeenCalled();
    expect(mockDb.tables.coaching_sessions[0]).toMatchObject({ status: 'analysis_complete', analysis_data: { summary: 'ok' } });
    expect(mockDraft.onAnalysisReady).toHaveBeenCalledWith('obs-1', 'mtx:15550100001');
  });

  test('a teacher\'s own recording keeps its framework, progress messages and reflective chat', async () => {
    await AnalysisProcessor.processAnalysis('dc-1', { from: 'mtx:15550100002' });
    expect(mockSelector.selectFramework).toHaveBeenCalledWith('t-1');
    expect(mockGpt.extractReflectiveCorpus).toHaveBeenCalled();
    expect(AnalysisProcessor.sendProgressUpdate).toHaveBeenCalledWith('mtx:15550100002', 2);
    expect(mockReflective.conductReflectiveConversation).toHaveBeenCalledWith('dc-1', 'mtx:15550100002');
    expect(mockDraft.onAnalysisReady).not.toHaveBeenCalled();
  });
});
