/**
 * Voice roll call knows Leave.
 *
 * "Fay is on leave" / "Fay ki chutti hai" used to be read as ABSENT — the leave
 * keywords sat in the absent lists — so a voice-marked register filed approved
 * leave as absence, the exact misreport the register exists to prevent.
 *
 * The LLM is the network boundary: its client is stubbed, the extraction and the
 * record building run for real.
 */

const mockCreate = jest.fn();
jest.mock('../../bot/shared/services/llm-client', () => ({
  getClient: () => ({ chat: { completions: { create: (...a) => mockCreate(...a) } } }),
}));
jest.mock('../../bot/shared/services/audio.service', () => ({ transcribe: jest.fn() }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const VoiceAttendanceService = require('../../bot/shared/services/voice-attendance.service');

const ROSTER = [
  { id: 'k1', student_name: 'Dana Lee', roll_number: 1 },
  { id: 'k2', student_name: 'Eli Moss', roll_number: 2 },
  { id: 'k3', student_name: 'Fay Ng', roll_number: 3 },
];

beforeEach(() => jest.clearAllMocks());

describe('keywords', () => {
  it.each(['on leave', 'leave', 'چھٹی'])('%j is leave, not absent', (kw) => {
    expect(VoiceAttendanceService.parseAttendanceKeyword(kw)).toBe('leave');
  });

  it('absent is still absent', () => {
    expect(VoiceAttendanceService.parseAttendanceKeyword('absent')).toBe('absent');
    expect(VoiceAttendanceService.parseAttendanceKeyword('غیر حاضر')).toBe('absent');
  });
});

describe('the extraction request', () => {
  it('asks for present, absent or leave, and names no one country', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"attendance": []}' } }] });
    await VoiceAttendanceService.extractAttendanceWithGPT('Fay is on leave', ROSTER);

    const { messages } = mockCreate.mock.calls[0][0];
    const text = messages.map((m) => m.content).join('\n');
    expect(text).toMatch(/present\|absent\|leave/);
    // The system prompt describes schools in general, not one country's schools.
    expect(text).toMatch(/assistant for schools\./);
  });
});

describe('records', () => {
  it('carries a leave status through to the record and the summary', () => {
    const records = VoiceAttendanceService.generateAttendanceRecords(ROSTER, [
      { name: 'Eli Moss', status: 'absent', confidence: 0.9 },
      { name: 'Fay Ng', status: 'leave', confidence: 0.9 },
    ]);
    expect(records.map((r) => r.status)).toEqual(['present', 'absent', 'leave']);
    expect(VoiceAttendanceService.getSummary(records)).toMatchObject({ present: 1, absent: 1, leave: 1 });
  });

  it('an unknown status from the model falls back to the default rather than being stored', () => {
    const records = VoiceAttendanceService.generateAttendanceRecords(ROSTER, [
      { name: 'Eli Moss', status: 'sort of here', confidence: 0.4 },
    ]);
    expect(records[1].status).toBe('present');
  });
});
