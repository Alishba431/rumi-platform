/**
 * Saving a class's day and delivering the month's register.
 *
 * The rules this pins, each one a way the old delivery let a teacher down:
 *
 *   1. RE-MARKING A DAY REPLACES IT. The old path hit a duplicate guard and stopped
 *      ("Attendance Already Recorded … select View Register", an option that does not
 *      exist), so a teacher who made a mistake had no way to fix it.
 *   2. A CORRECTION REGENERATES THE WHOLE MONTH. The register is rebuilt from every
 *      session in the month, so the corrected file still holds every other day.
 *   3. THE MONTH IS THE MONTH OF THE DATE STRING. Taken through `new Date(...)` it
 *      slid a day either side of UTC, and the month's last day fell out of the query.
 *   4. STORAGE IS AN ARCHIVE, NOT A GATE. Without R2 the file is still delivered.
 *   5. THE SEND RESULT IS THE SEND RESULT. A channel that refused the document is
 *      not reported as success.
 */

const fs = require('fs');
const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
const mockUpload = jest.fn();
const mockR2Configured = jest.fn();
const mockSendDocument = jest.fn();
const mockSent = [];

// Mocked at the client library (the network boundary): the real config/supabase.js loads and hands
// every service this in-memory client.
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t) => mockDb.client.from(t) }) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/storage/r2', () => ({
  uploadBuffer: (...a) => mockUpload(...a),
  isR2Configured: () => mockR2Configured(),
  getSignedUrl: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendDocument: (...a) => mockSendDocument(...a),
  sendMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/attendance-conversation.service', () => ({
  clearSessionState: jest.fn().mockResolvedValue(true),
}));

const AttendanceDeliveryService = require('../../bot/shared/services/attendance-delivery.service');

const CLASS = { id: 'L1', class_name: 'Grade 5', section: 'A' };

function seed() {
  mockDb = createAttendanceDb({
    student_lists: [{ ...CLASS, user_id: 't1', is_active: true }],
    students: [
      { id: 'k1', list_id: 'L1', roll_number: 1, student_name: 'Dana Lee', is_active: true },
      { id: 'k2', list_id: 'L1', roll_number: 2, student_name: 'Eli Moss', is_active: true },
      { id: 'k3', list_id: 'L1', roll_number: 3, student_name: 'Fay Ng', is_active: true },
    ],
  });
}

function day(date, statuses) {
  const names = { k1: 'Dana Lee', k2: 'Eli Moss', k3: 'Fay Ng' };
  return {
    selectedClass: CLASS,
    selectedListId: 'L1',
    markingMethod: 'tap',
    sessionDate: date,
    records: Object.entries(statuses).map(([studentId, status]) => ({
      studentId, studentName: names[studentId], status,
    })),
  };
}

/** The register the teacher received last, read back off the recording exceljs stub. */
function lastRegister() {
  const { buffer, fileName, caption, to } = mockSent[mockSent.length - 1];
  const [sheet] = JSON.parse(buffer.toString());
  const row = (name) => sheet.rows.find((r) => r[1] === name);
  return { sheet, row, fileName, caption, to };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSent.length = 0;
  seed();
  mockR2Configured.mockReturnValue(true);
  mockUpload.mockResolvedValue('https://storage.example/register.xlsx');
  mockSendDocument.mockImplementation(async (to, filePath, fileName, caption) => {
    mockSent.push({ to, fileName, caption, buffer: fs.readFileSync(filePath) });
    return true;
  });
});

describe('a first mark', () => {
  it('saves Leave as its own status with a leave tally on the session', async () => {
    const result = await AttendanceDeliveryService.processAndDeliver(
      't1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'absent', k3: 'leave' }),
    );

    expect(result.success).toBe(true);
    const [session] = mockDb.rowsOf('attendance_sessions');
    expect(session).toMatchObject({
      session_date: '2026-09-04', present_count: 1, absent_count: 1, leave_count: 1, total_students: 3,
    });
    expect(mockDb.rowsOf('attendance_records').map((r) => r.status).sort())
      .toEqual(['absent', 'leave', 'present']);
  });

  it('sends the month register to the address the teacher wrote from, Leave in the cell and the caption', async () => {
    await AttendanceDeliveryService.processAndDeliver(
      't1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'absent', k3: 'leave' }),
    );

    const { row, fileName, caption, to } = lastRegister();
    expect(to).toBe('15550100001');
    expect(fileName).toBe('Attendance_Grade_5_A_September_2026.xlsx');
    expect(row('Fay Ng')[2 + 4 - 1]).toBe('L');
    expect(caption).toMatch(/On leave: 1/);
  });
});

describe('correcting a day', () => {
  it('replaces the day instead of refusing it as a duplicate', async () => {
    await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'absent', k3: 'present' }));
    const second = await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'leave', k3: 'present' }));

    expect(second.success).toBe(true);
    expect(second.isDuplicate).toBeUndefined();
    expect(second.replaced).toBe(true);

    const sessions = mockDb.rowsOf('attendance_sessions');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ absent_count: 0, leave_count: 1, was_manually_edited: true });
    const records = mockDb.rowsOf('attendance_records').filter((r) => r.session_id === sessions[0].id);
    expect(records).toHaveLength(3);
    expect(records.find((r) => r.student_id === 'k2').status).toBe('leave');
  });

  it('regenerates the whole month, so the corrected file still holds every other day', async () => {
    await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'absent', k3: 'present' }));
    await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-07', { k1: 'absent', k2: 'present', k3: 'present' }));
    await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'present', k3: 'present' }));

    const { row, caption } = lastRegister();
    const eli = row('Eli Moss');
    expect(eli[2 + 4 - 1]).toBe('P');   // the corrected 4th
    expect(eli[2 + 7 - 1]).toBe('P');   // the 7th, untouched
    expect(row('Dana Lee')[2 + 7 - 1]).toBe('A');
    expect(caption).toMatch(/updated/i);
  });
});

describe('the month boundary', () => {
  it('files the 30th in September and the 1st in a new October register', async () => {
    await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-30', { k1: 'absent', k2: 'present', k3: 'present' }));
    let reg = lastRegister();
    expect(reg.fileName).toBe('Attendance_Grade_5_A_September_2026.xlsx');
    expect(reg.row('Dana Lee')[2 + 30 - 1]).toBe('A');

    await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-10-01', { k1: 'present', k2: 'present', k3: 'leave' }));
    reg = lastRegister();
    expect(reg.fileName).toBe('Attendance_Grade_5_A_October_2026.xlsx');
    // October's register starts clean: September's 30th is not carried into it.
    const dana = reg.row('Dana Lee');
    expect(dana[2 + 1 - 1]).toBe('P');
    expect(dana.slice(-4)).toEqual([1, 0, 0, '100%']);
  });
});

describe('delivery', () => {
  it('still delivers the register when no object storage is configured', async () => {
    mockR2Configured.mockReturnValue(false);
    const result = await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'present', k3: 'present' }));

    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockSendDocument).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('still delivers the register when storage is configured but down', async () => {
    mockUpload.mockRejectedValue(new Error('storage unreachable'));
    const result = await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'present', k3: 'present' }));

    expect(mockSendDocument).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('reports a refused send as a failure — but the day stays saved', async () => {
    mockSendDocument.mockResolvedValue(false);
    const result = await AttendanceDeliveryService.processAndDeliver('t1', '15550100001', day('2026-09-04', { k1: 'present', k2: 'absent', k3: 'present' }));

    expect(result.success).toBe(false);
    expect(result.saved).toBe(true);
    expect(mockDb.rowsOf('attendance_sessions')).toHaveLength(1);
  });
});
