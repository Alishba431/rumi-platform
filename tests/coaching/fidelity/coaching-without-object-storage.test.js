'use strict';
/**
 * Object storage (R2) is optional in .env.template, and r2.js offers isR2Configured() precisely so callers fall back
 * instead of failing. Classroom coaching did not: the transcription job failed on "S3Client cannot be constructed"
 * before transcribing anything, and the voice note could only be sent from a storage URL. Without R2, the classroom
 * audio is simply not archived and the voice note is sent from memory.
 */
jest.mock('../../../bot/shared/utils/logger', () => ({ logToFile: jest.fn(), logWarn: jest.fn() }));
const mockR2 = { configured: false };
jest.mock('../../../bot/shared/storage/r2', () => ({
  isR2Configured: () => mockR2.configured,
  uploadClassroomAudio: jest.fn(async () => 'https://r2.example.com/a.ogg'),
  uploadVoiceDebrief: jest.fn(async () => 'https://r2.example.com/v.mp3'),
  uploadReportPDF: jest.fn(),
  uploadImageWithRetry: jest.fn(),
}));
jest.mock('../../../bot/shared/config/supabase', () => ({ from: () => ({ update: () => ({ eq: async () => ({}) }) }) }));
jest.mock('../../../bot/shared/services/audio.service', () => ({ generateSpeechForLanguage: jest.fn(async () => Buffer.alloc(16000)) }));
jest.mock('../../../bot/shared/services/whatsapp.service', () => ({ sendMessage: jest.fn(async () => true), sendAudioFromUrl: jest.fn(async () => true), sendAudio: jest.fn(async () => true) }));
jest.mock('../../../bot/shared/services/coaching/coaching-helpers.service', () => ({ determineOutputLanguage: jest.fn(async () => 'en') }));
// PDFKit is a bot-only dependency (not installed for the root suite); the report renderer is not under test here.
jest.mock('pdfkit', () => function FakePDF() {}, { virtual: true });
jest.mock('jsonrepair', () => ({ jsonrepair: (s) => s }), { virtual: true });
jest.mock('dotenv', () => ({ config: () => ({}) }), { virtual: true });

const r2 = require('../../../bot/shared/storage/r2');
const WhatsAppService = require('../../../bot/shared/services/whatsapp.service');
const GPT5MiniService = require('../../../bot/shared/services/gpt5-mini.service');
const ReportGeneratorService = require('../../../bot/shared/services/coaching/report-generator.service');
const { archiveClassroomAudio } = require('../../../bot/shared/services/coaching/transcription-processor.service');

beforeEach(() => jest.clearAllMocks());

describe('classroom audio archive', () => {
  test('no R2 → not archived (null), and no storage client is ever built', async () => {
    mockR2.configured = false;
    expect(await archiveClassroomAudio('/tmp/a.ogg', 'u1', 's1', { duration: 240 })).toBeNull();
    expect(r2.uploadClassroomAudio).not.toHaveBeenCalled();
  });

  test('R2 configured → archived as before', async () => {
    mockR2.configured = true;
    expect(await archiveClassroomAudio('/tmp/a.ogg', 'u1', 's1', { duration: 240 })).toBe('https://r2.example.com/a.ogg');
  });
});

describe('voice note delivery', () => {
  beforeEach(() => jest.spyOn(GPT5MiniService, 'summarizeForVoiceDebrief').mockResolvedValue('script'));
  afterEach(() => jest.restoreAllMocks());
  const session = { id: 's1', user_id: 'u1', users: { preferred_language: 'en' }, conversation_state: {} };

  test('no R2 → the voice note is sent from memory', async () => {
    mockR2.configured = false;
    await ReportGeneratorService.generateAndSendVoiceDebrief(session, 'matrix:@t:local', 's1', { framework: 'oecd' });
    expect(WhatsAppService.sendAudio).toHaveBeenCalledWith('matrix:@t:local', expect.any(Buffer), expect.any(String));
    expect(WhatsAppService.sendAudioFromUrl).not.toHaveBeenCalled();
    expect(r2.uploadVoiceDebrief).not.toHaveBeenCalled();
  });

  test('R2 configured → uploaded and sent by URL, as before', async () => {
    mockR2.configured = true;
    await ReportGeneratorService.generateAndSendVoiceDebrief(session, '15550001111', 's1', { framework: 'oecd' });
    expect(WhatsAppService.sendAudioFromUrl).toHaveBeenCalledWith('15550001111', 'https://r2.example.com/v.mp3');
  });
});
