'use strict';
/**
 * After the report document, the teacher gets one chat line about the plan — the band in words and the move count,
 * or exactly why the lesson was not compared. generateReport runs for real; the LLM passes, rendering, storage and
 * messaging are faked at their boundaries.
 */
const { makeFakeDb } = require('./_fake-db');

let mockDb;
jest.mock('../../../bot/shared/config/supabase', () => new Proxy({}, { get: (_t, k) => mockDb[k] }));
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
jest.mock('../../../bot/shared/storage/r2', () => ({ uploadVoiceDebrief: jest.fn(), uploadReportPDF: jest.fn(async () => 'https://r2.example.com/r.pdf'), uploadImageWithRetry: jest.fn() }));
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn(async () => true), sendDocument: jest.fn(async () => true), sendAudioFromUrl: jest.fn(async () => true),
  sendImageFromUrl: jest.fn(async () => true), sendInteractiveButtons: jest.fn(async () => true),
}));
jest.mock('../../../bot/shared/services/feature-linker.service', () => ({ suggestNext: jest.fn() }));
// PDFKit is a bot-only dependency (not installed for the root suite); the report renderer is not under test here.
jest.mock('pdfkit', () => function FakePDF() {}, { virtual: true });
jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
jest.mock('dotenv', () => ({ config: () => ({}) }), { virtual: true });

const WhatsAppService = require('../../../bot/shared/services/whatsapp.service');
const GPT5MiniService = require('../../../bot/shared/services/gpt5-mini.service');
const PDFReportService = require('../../../bot/shared/services/pdf-report.service');
const ReportGeneratorService = require('../../../bot/shared/services/coaching/report-generator.service');
const { fidelityChatLineFor } = require('../../../bot/shared/services/coaching/fidelity/fidelity-report');

const LP = {
  status: 'ok', source: 'pasted', fidelity_pct: 100, band: 'high', not_assessed: [], moderators: { note: '' },
  moves: [{ move_id: 'm1', phase: 'explain', verdict: 'executed', counted: true, credit: 1, text: 'Explain', evidence: '[00:10] x' }],
};

function seed(analysis) {
  mockDb = makeFakeDb({
    coaching_sessions: [{
      id: 's1', user_id: 'u1', status: 'generating_report', created_at: '2026-10-01T09:00:00Z', transcript_text: '[00:10] x',
      analysis_data: analysis, conversation_state: { questions: [] },
      users: { phone_number: '15550001111', first_name: 'Sam', last_name: 'Teacher', preferred_language: 'en' },
    }],
  });
}

describe('generateReport · the fidelity chat line', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(GPT5MiniService, 'enhanceAnalysisWithReflections').mockImplementation(async (a) => a);
    jest.spyOn(GPT5MiniService, 'inferLessonTopic').mockResolvedValue('N/A');
    jest.spyOn(GPT5MiniService, 'inferLessonSubject').mockResolvedValue('N/A');
    jest.spyOn(PDFReportService, 'generateClassroomObservationReport').mockResolvedValue(Buffer.from('%PDF-1.4'));
    jest.spyOn(ReportGeneratorService, 'generateAndSendVoiceDebrief').mockResolvedValue();
  });
  afterEach(() => jest.restoreAllMocks());

  test('sent right after the report document, with the band in words', async () => {
    seed({ framework: 'oecd', scores: {}, lp_fidelity: LP });
    await ReportGeneratorService.generateReport('s1', { from: 'matrix:@t:local' });
    const texts = WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);
    const line = fidelityChatLineFor(LP, 'en');
    expect(texts).toContain(line);
    expect(line).toContain('you followed your plan closely');
    const docOrder = WhatsAppService.sendDocument.mock.invocationCallOrder[0];
    const lineOrder = WhatsAppService.sendMessage.mock.invocationCallOrder[texts.indexOf(line)];
    expect(lineOrder).toBeGreaterThan(docOrder);
  });

  test('no plan linked → its own line', async () => {
    seed({ framework: 'oecd', scores: {}, lp_fidelity: { status: 'lp_absent' } });
    await ReportGeneratorService.generateReport('s1', { from: 'matrix:@t:local' });
    const texts = WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);
    expect(texts).toContain(fidelityChatLineFor({ status: 'lp_absent' }, 'en'));
  });

  test('flag off (no lp_fidelity) → no fidelity line at all', async () => {
    seed({ framework: 'oecd', scores: {} });
    await ReportGeneratorService.generateReport('s1', { from: 'matrix:@t:local' });
    const texts = WhatsAppService.sendMessage.mock.calls.map((c) => c[1]);
    expect(texts.some((t) => /📋/.test(t))).toBe(false);
  });
});
