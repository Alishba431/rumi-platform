'use strict';
/**
 * Live-path guards from the review (S5): each test fails if its guard is removed or inverted.
 *   1. the voice handler measures a recording once and reuses that download (no second download)
 *   2. with fidelity on, the classroom-photo limit leads to the lesson-plan step, not straight to analysis
 *   3. the enhance rewrite may not invent an lp_fidelity when the analysis had none
 *   4. a recompute never writes once the session has left the recomputable window (the status-guarded write)
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));
jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
jest.mock('dotenv', () => ({ config: () => ({}) }), { virtual: true });
jest.mock('pdfkit', () => function FakePDF() {}, { virtual: true });
// Bot-only dependencies, not installed for the root suite.
jest.mock('uuid', () => ({ v4: () => '00000000-0000-4000-8000-000000000000' }), { virtual: true });
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({
  startContinuousTypingIndicator: jest.fn(() => ({ stop: jest.fn() })),
  getMediaInfo: jest.fn(async () => ({ mime_type: 'audio/ogg' })),
  downloadMedia: jest.fn(async () => Buffer.from('OggS audio bytes')),
  sendMessage: jest.fn(async () => true),
  sendInteractiveMessage: jest.fn(async () => true),
  sendInteractiveButtons: jest.fn(async () => true),
  sendSticker: jest.fn(async () => true),
}));
jest.mock('../../../bot/shared/storage/r2', () => ({
  isR2Configured: () => false, uploadAudio: jest.fn(), uploadImageWithRetry: jest.fn(async () => 'https://r2.example.com/p.jpg'),
}));
// The voice handler's other collaborators are not under test (menus, video, attendance, registration, the LP queue,
// the reading-assessment session store); they are stubbed so only the duration → download path runs.
jest.mock('../../../bot/shared/services/openai.service', () => ({}));
jest.mock('../../../bot/shared/services/content.service', () => ({}));
jest.mock('../../../bot/shared/services/feature-registration.service', () => ({ checkAndTriggerRegistration: jest.fn() }));
jest.mock('../../../bot/shared/services/coaching-orchestrator.service', () => ({ initiateCoachingSession: jest.fn() }));
jest.mock('../../../bot/shared/services/menu.service', () => ({}));
jest.mock('../../../bot/shared/services/video/video-orchestrator.service', () => ({}));
jest.mock('../../../bot/shared/services/lesson-plan-queue.service', () => ({}));
jest.mock('../../../bot/shared/services/attendance-conversation.service', () => ({ getState: jest.fn(async () => null), isActive: jest.fn(async () => false) }));
jest.mock('../../../bot/shared/database/bot-helpers', () => ({ getOrCreateSession: jest.fn(async () => 'chat-1'), storeConversation: jest.fn(), storeAudioSession: jest.fn() }));
jest.mock('../../../bot/shared/utils/language-cache', () => ({ getUserLanguage: jest.fn(async () => 'en'), setUserLanguage: jest.fn() }));
jest.mock('../../../bot/shared/services/cache/railway-redis.service', () => ({ get: jest.fn(async () => null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), isDuplicateMessage: jest.fn(async () => false), markMessageProcessed: jest.fn() }));
jest.mock('../../../bot/shared/services/coaching/coaching-job-queue.service', () => ({ queueAnalysis: jest.fn(async () => true) }));

const WhatsAppService = require('../../../bot/shared/services/whatsapp.service');
const CoachingJobQueueService = require('../../../bot/shared/services/coaching/coaching-job-queue.service');

const SID = '11111111-2222-3333-4444-555555555555';
const saved = process.env.LP_FIDELITY_ENABLED;
afterEach(() => { if (saved === undefined) delete process.env.LP_FIDELITY_ENABLED; else process.env.LP_FIDELITY_ENABLED = saved; jest.clearAllMocks(); });

describe('1 · the voice handler downloads a recording once', () => {
  test('no duration from the channel → measured from one download, and that download is reused', async () => {
    mockDb = makeFakeDb({});
    const AudioService = require('../../../bot/shared/services/audio.service');
    jest.spyOn(AudioService, 'getAudioDuration').mockResolvedValue(12);
    jest.spyOn(AudioService, 'convertToWav').mockRejectedValue(new Error('stop here'));
    const { handleVoiceMessage } = require('../../../bot/shared/handlers/voice-message.handler');
    await handleVoiceMessage({ id: 'wamid.1', voice: { id: 'media-1' } }, 'matrix:@t:local', { id: 'u1', preferred_language: 'en' }).catch(() => {});
    expect(AudioService.getAudioDuration).toHaveBeenCalledTimes(1);
    expect(WhatsAppService.downloadMedia).toHaveBeenCalledTimes(1);
  });
});

describe('2 · the classroom-photo limit', () => {
  function seedPhotos(n) {
    mockDb = makeFakeDb({
      coaching_sessions: [{
        id: SID, user_id: 'u1', status: 'awaiting_photo', users: { preferred_language: 'en' },
        conversation_state: { current_state: 'COLLECTING_PHOTOS', classroom_photos: Array.from({ length: n }, (_, i) => ({ url: `p${i}` })) },
      }],
      users: [{ id: 'u1', preferred_language: 'en' }],
      lesson_plans: [],
    });
  }
  const handle = () => require('../../../bot/shared/handlers/image-message.handler').handleImageMessage(
    { id: 'wamid.2', image: { id: 'img-1', mime_type: 'image/jpeg' } }, 'matrix:@t:local', { id: 'u1', preferred_language: 'en' },
  );

  test.each([[2, 'the third photo'], [3, 'a photo past the limit']])('fidelity on, %i photos held (%s) → the lesson-plan step, no analysis yet', async (n) => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    seedPhotos(n);
    await handle();
    expect(mockDb.tables.coaching_sessions[0].status).toBe('awaiting_lesson_plan');
    expect(CoachingJobQueueService.queueAnalysis).not.toHaveBeenCalled();
  });

  test.each([[2], [3]])('fidelity off, %i photos held → the analysis is queued as before', async (n) => {
    delete process.env.LP_FIDELITY_ENABLED;
    seedPhotos(n);
    await handle();
    expect(CoachingJobQueueService.queueAnalysis).toHaveBeenCalledTimes(1);
    expect(mockDb.tables.coaching_sessions[0].status).toBe('analysis_started');
  });
});

describe('3 · the enhance rewrite cannot invent a fidelity result', () => {
  test('no lp_fidelity going in → none coming out, whatever the rewrite says', async () => {
    mockDb = makeFakeDb({});
    const GPT5MiniService = require('../../../bot/shared/services/gpt5-mini.service');
    const original = GPT5MiniService.openai;
    GPT5MiniService.openai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ framework: 'oecd', lp_fidelity: { status: 'ok', fidelity_pct: 100 } }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } };
    try {
      const out = await GPT5MiniService.enhanceAnalysisWithReflections({ framework: 'oecd' }, 't', { questions: [{ question_number: 1, question: 'q', answer: 'a' }] }, {}, null, null);
      expect(out).not.toHaveProperty('lp_fidelity');
    } finally { GPT5MiniService.openai = original; }
  });
});

describe('4 · the recompute write is guarded on the session status', () => {
  test('the session moved on (report started) between the read and the write → nothing is written', async () => {
    process.env.LP_FIDELITY_ENABLED = 'true';
    const PLAN = 'Explain adding fractions with paper fraction strips folded into fifths, then an exit ticket with one question each.';
    const before = { framework: 'oecd', lp_fidelity: { status: 'lp_absent' } };
    mockDb = makeFakeDb({ coaching_sessions: [{ id: 's1', status: 'generating_report', analysis_data: before }] });
    const { recomputeFidelityForSession } = require('../../../bot/shared/services/coaching/fidelity/fidelity-recompute.service');
    const r = await recomputeFidelityForSession('s1', {
      // what the session looked like when it was read, a moment earlier
      loadSession: async () => ({ id: 's1', status: 'conducting_conversation', transcript_text: '[00:10] Teacher (EN): fold', lesson_plan_text: PLAN, lesson_plan_link_method: 'pasted', analysis_data: before }),
      extractPlanMoves: async () => ({ goal: 'g', moves: [{ move_id: 'm1', phase: 'explain', text: 'Explain', bucket: 'must_happen' }] }),
      analyzeFidelity: async () => ({ verdicts: [{ move_id: 'm1', verdict: 'executed', evidence: '[00:10] fold' }], model: 'm' }),
    });
    expect(r.recomputed).toBe(false);
    expect(mockDb.tables.coaching_sessions[0].analysis_data).toBe(before);
  });
});
