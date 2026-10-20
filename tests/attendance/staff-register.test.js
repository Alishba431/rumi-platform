/**
 * Staff attendance — a head teacher marks the school's staff, and gets the staff
 * register back.
 *
 * Who counts as staff is defined once (loadStaffRoster): everyone linked to the
 * school except the person marking. One row per person per day in
 * teacher_attendance_records; re-marking a day overwrites it. The register uses the
 * staff rule: approved leave is neither present nor absent.
 */

const fs = require('fs');
const { createAttendanceDb } = require('./_helpers/attendance-db');

let mockDb;
const mockSendDocument = jest.fn();
const mockSent = [];

// Mocked at the client library (the network boundary): the real config/supabase.js loads and hands
// every service this in-memory client.
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (t) => mockDb.client.from(t) }) }));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/storage/r2', () => ({
  uploadBuffer: jest.fn(),
  isR2Configured: () => false,
  getSignedUrl: jest.fn(),
}));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendDocument: (...a) => mockSendDocument(...a),
  sendMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/services/attendance-conversation.service', () => ({
  clearSessionState: jest.fn().mockResolvedValue(true),
}));

const StaffAttendance = require('../../bot/shared/services/staff-attendance.service');
const AttendanceDeliveryService = require('../../bot/shared/services/attendance-delivery.service');

const SCHOOL = { id: 'sch1', name: 'Hillside Primary', ext_id: null };

function seed() {
  mockDb = createAttendanceDb({
    schools: [SCHOOL, { id: 'sch2', name: 'Riverside Primary' }],
    users: [
      { id: 'h1', name: 'Grace Hall', role: 'head_teacher', school_id: 'sch1' },
      { id: 't1', name: 'Amara Okafor', role: null, school_id: 'sch1' },
      { id: 't2', name: 'Ben Ito', role: 'teacher', school_id: 'sch1' },
      // A colleague who does not use the bot: on the roster by name only.
      { id: 't3', name: 'Chen Rao', role: null, school_id: 'sch1', phone_number: null },
      { id: 'x1', name: 'Other School Teacher', role: null, school_id: 'sch2' },
    ],
  });
}

function staffDay(date, statuses) {
  const names = { t1: 'Amara Okafor', t2: 'Ben Ito', t3: 'Chen Rao' };
  return {
    subject: 'staff',
    schoolId: 'sch1',
    selectedClass: { class_name: SCHOOL.name },
    markingMethod: 'tap',
    sessionDate: date,
    records: Object.entries(statuses).map(([studentId, status]) => ({ studentId, studentName: names[studentId], status })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSent.length = 0;
  seed();
  mockSendDocument.mockImplementation(async (to, filePath, fileName, caption) => {
    mockSent.push({ to, fileName, caption, buffer: fs.readFileSync(filePath) });
    return true;
  });
});

describe('who is staff', () => {
  it('is everyone at the school except the person marking, name-only colleagues included', async () => {
    const staff = await StaffAttendance.loadStaffRoster('sch1', 'h1');
    expect(staff.map((s) => s.name)).toEqual(['Amara Okafor', 'Ben Ito', 'Chen Rao']);
  });

  it('is nobody when there is no school', async () => {
    expect(await StaffAttendance.loadStaffRoster(null, 'h1')).toEqual([]);
  });
});

describe('the role', () => {
  it('a head teacher is head_teacher, and the principal / school_leader aliases count too', () => {
    expect(StaffAttendance.isHeadTeacher({ role: 'head_teacher' })).toBe(true);
    expect(StaffAttendance.isHeadTeacher({ role: 'principal' })).toBe(true);
    expect(StaffAttendance.isHeadTeacher({ role: 'school_leader' })).toBe(true);
    expect(StaffAttendance.isHeadTeacher({ role: 'coach' })).toBe(false);
    expect(StaffAttendance.isHeadTeacher({ role: 'teacher' })).toBe(false);
    expect(StaffAttendance.isHeadTeacher({ role: null })).toBe(false);
  });
});

describe('marking staff through the one delivery door', () => {
  it('writes one row per colleague for the day, Leave included, stamped with who marked it', async () => {
    const result = await AttendanceDeliveryService.processAndDeliver(
      'h1', '15550100009', staffDay('2026-09-04', { t1: 'present', t2: 'absent', t3: 'leave' }),
    );

    expect(result.success).toBe(true);
    const rows = mockDb.rowsOf('teacher_attendance_records');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.teacher_id === 't3')).toMatchObject({
      school_id: 'sch1', date: '2026-09-04', status: 'leave', marked_by_user_id: 'h1',
    });
  });

  it('re-marking a day overwrites it rather than duplicating, and says so', async () => {
    await AttendanceDeliveryService.processAndDeliver('h1', '15550100009', staffDay('2026-09-04', { t1: 'present', t2: 'absent', t3: 'present' }));
    const second = await AttendanceDeliveryService.processAndDeliver('h1', '15550100009', staffDay('2026-09-04', { t1: 'present', t2: 'leave', t3: 'present' }));

    expect(second.replaced).toBe(true);
    const rows = mockDb.rowsOf('teacher_attendance_records');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.teacher_id === 't2').status).toBe('leave');
  });

  it('sends the staff register for the month, with the staff rate', async () => {
    await AttendanceDeliveryService.processAndDeliver('h1', '15550100009', staffDay('2026-09-04', { t1: 'present', t2: 'absent', t3: 'leave' }));
    await AttendanceDeliveryService.processAndDeliver('h1', '15550100009', staffDay('2026-09-07', { t1: 'present', t2: 'present', t3: 'present' }));

    const { to, fileName, caption, buffer } = mockSent[mockSent.length - 1];
    expect(to).toBe('15550100009');
    expect(fileName).toBe('Staff_Attendance_Hillside_Primary_September_2026.xlsx');
    expect(caption).toMatch(/Staff Attendance Register/);

    const [sheet] = JSON.parse(buffer.toString());
    expect(sheet.name).toBe('Staff Register');
    const chen = sheet.rows.find((r) => r[0] === 'Chen Rao');
    expect(chen[4]).toBe('L');
    // P 1, A 0, L 1 — approved leave is excused, so 1 / 1.
    expect(chen.slice(-4)).toEqual([1, 0, 1, '100%']);
    // Nobody from another school is on it.
    expect(sheet.rows.find((r) => r[0] === 'Other School Teacher')).toBeUndefined();
  });

  it('never writes rows for someone who is not on this school\'s staff', async () => {
    const day = staffDay('2026-09-04', { t1: 'present' });
    day.records.push({ studentId: 'x1', studentName: 'Other School Teacher', status: 'absent' });
    await AttendanceDeliveryService.processAndDeliver('h1', '15550100009', day);

    expect(mockDb.rowsOf('teacher_attendance_records').map((r) => r.teacher_id)).toEqual(['t1']);
  });
});
