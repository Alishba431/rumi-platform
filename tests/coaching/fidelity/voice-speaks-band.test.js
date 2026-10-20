'use strict';
/**
 * The teacher's voice note speaks the BAND in words ("you followed part of your plan"), never a percentage: one
 * grading's percentage carries a few points of wobble, and a number read aloud sounds like a verdict. The voice
 * prompt serialises the whole analysis, so the projection must remove every number it could quote — the blob's
 * percentage, every run's percentage, the per-move rows — not just the scalar it is handed.
 *
 * generateAndSendVoiceDebrief runs for real; the voice-script LLM, TTS, storage and messaging are faked.
 */
jest.mock('../../../bot/shared/config/supabase', () => ({ from: () => ({ update: () => ({ eq: async () => ({}) }) }) }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
jest.mock('../../../bot/shared/storage/r2', () => ({ isR2Configured: () => true, uploadVoiceDebrief: jest.fn(async () => 'https://r2.example.com/v.mp3'), uploadReportPDF: jest.fn() }));
jest.mock('../../../bot/shared/services/audio.service', () => ({ generateSpeechForLanguage: jest.fn(async () => Buffer.alloc(32000)) }));
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn(async () => true), sendAudioFromUrl: jest.fn(async () => true) }));
jest.mock('../../../bot/shared/services/coaching/coaching-helpers.service', () => ({ determineOutputLanguage: jest.fn(async () => 'en') }));
// PDFKit is a bot-only dependency (not installed for the root suite); the report renderer is not under test here.
jest.mock('pdfkit', () => function FakePDF() {}, { virtual: true });
jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
jest.mock('dotenv', () => ({ config: () => ({}) }), { virtual: true });

const GPT5MiniService = require('../../../bot/shared/services/gpt5-mini.service');
const ReportGeneratorService = require('../../../bot/shared/services/coaching/report-generator.service');

const LP = {
  status: 'ok', source: 'linked', fidelity_pct: 66.7, band: 'partial', runs: [{ pct: 66.7 }, { pct: 75.2 }], spread: 8.5,
  narrative: 'n', not_assessed: [], moderators: { note: '' },
  moves: [
    { move_id: 'm1', verdict: 'executed', counted: true, credit: 1, text: 'Explain with strips', evidence: '[00:50] fold' },
    { move_id: 'm2', verdict: 'not_done', counted: true, credit: 0, text: 'Exit ticket', evidence: '' },
    { move_id: 'm3', verdict: 'partial', counted: true, credit: 0.5, text: 'Guided practice', evidence: '[02:05] two eighths' },
  ],
};

describe('voice debrief · lesson-plan fidelity', () => {
  let seen;
  beforeEach(() => {
    seen = null;
    jest.spyOn(GPT5MiniService, 'summarizeForVoiceDebrief').mockImplementation(async (data) => { seen = data; return 'script'; });
  });
  afterEach(() => jest.restoreAllMocks());

  const session = { id: 's1', user_id: 'u1', users: { preferred_language: 'en' }, conversation_state: {} };

  test('the voice sees the band and the move count, and no number it could read out as a score', async () => {
    await ReportGeneratorService.generateAndSendVoiceDebrief(session, 'matrix:@t:local', 's1', { framework: 'oecd', has_lesson_plan: true, fidelity_analysis: { score: 85 }, lp_fidelity: LP });
    expect(seen.lessonPlanFidelity).toEqual({ assessed: true, band: 'partial', band_words: 'you followed part of your plan', planned_moves_delivered: '1 of 3', lesson_mismatch: false });
    expect(seen.fidelityScore).toBeNull();
    const dump = JSON.stringify(seen);
    for (const leak of ['66.7', '75.2', 'fidelity_pct', 'fidelity_analysis', 'Explain with strips', '[00:50]']) expect(dump).not.toContain(leak);
  });

  test('a recording that could not be assessed is said as such, with no band', async () => {
    await ReportGeneratorService.generateAndSendVoiceDebrief(session, 'matrix:@t:local', 's1', { framework: 'oecd', lp_fidelity: { status: 'ok', fidelity_pct: null, unusable_guard: 'no_timestamps', recording_unusable: true, moves: [] } });
    expect(seen.lessonPlanFidelity).toEqual({ assessed: false, reason: 'no_timings' });
  });

  test('flag off: the voice payload is exactly what it was', async () => {
    await ReportGeneratorService.generateAndSendVoiceDebrief(session, 'matrix:@t:local', 's1', { framework: 'oecd', has_lesson_plan: true, fidelity_analysis: { score: 85 } });
    expect(seen).toEqual({ analysis: { framework: 'oecd', has_lesson_plan: true, fidelity_analysis: { score: 85 } }, conversation: {}, hasLessonPlan: true, fidelityScore: 85 });
  });

  test('the voice prompt tells the model to speak the band in words and never a percentage', async () => {
    jest.restoreAllMocks();
    const calls = [];
    const original = GPT5MiniService.openai;
    GPT5MiniService.openai = { chat: { completions: { create: async (p) => { calls.push(p); return { choices: [{ message: { content: 'script' } }], usage: { completion_tokens: 1 } }; } } } };
    try {
      await GPT5MiniService.summarizeForVoiceDebrief({ analysis: {}, lessonPlanFidelity: { assessed: true, band: 'partial' } }, 'en');
    } finally { GPT5MiniService.openai = original; }
    const prompt = calls[0].messages[0].content;
    expect(prompt).toMatch(/lessonPlanFidelity/);
    expect(prompt).toMatch(/never (say|read out|mention) a percentage/i);
  });
});
