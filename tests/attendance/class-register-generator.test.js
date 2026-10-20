/**
 * The class register on its live path — AttendanceGeneratorService, which
 * attendance-delivery.service calls after every submit.
 *
 * Before this release it knew two statuses: anything that was not `present` became
 * `A`, so a child on approved leave was filed as absent. And it found the day with
 * `new Date(session_date).getDate()`, which in a negative UTC offset is the day
 * before — the whole month shifted one column left.
 */

// The offset case only bites when the process runs west of UTC; jest fixes its
// timezone at worker start, so exercise it with `TZ=America/New_York node tests/run.js`.

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const AttendanceGeneratorService = require('../../bot/shared/services/attendance-generator.service');

const STUDENTS = [
  { id: 'k1', roll_number: 1, student_name: 'Dana Lee' },
  { id: 'k2', roll_number: 2, student_name: 'Eli Moss' },
];

const SESSIONS = [
  {
    session_date: '2026-09-04',
    attendance_records: [
      { student_id: 'k1', status: 'present' },
      { student_id: 'k2', status: 'absent' },
    ],
  },
  {
    session_date: '2026-09-07',
    attendance_records: [
      { student_id: 'k1', status: 'leave' },
      { student_id: 'k2', status: 'present' },
    ],
  },
];

describe('buildAttendanceMatrix', () => {
  it('keeps Leave as its own status', () => {
    const m = AttendanceGeneratorService.buildAttendanceMatrix(STUDENTS, SESSIONS);
    expect(m.k1.days[7]).toBe('L');
  });

  it('puts a session on its own day even in a negative UTC offset', () => {
    const m = AttendanceGeneratorService.buildAttendanceMatrix(STUDENTS, SESSIONS);
    expect(m.k1.days[4]).toBe('P');
    expect(m.k1.days[3]).toBeUndefined();
  });
});

describe('createMonthlyRegisterBufferFromData', () => {
  let sheet;

  beforeAll(async () => {
    const buffer = await AttendanceGeneratorService.createMonthlyRegisterBufferFromData(
      { className: 'Grade 5', section: 'A' }, 9, 2026, STUDENTS, SESSIONS,
    );
    [sheet] = JSON.parse(buffer.toString());
  });

  it('names the class with its section', () => {
    const text = sheet.rows.flat().map((v) => String(v ?? '')).join(' ');
    expect(text).toContain('Grade 5 - A');
    expect(text).toContain('September 2026');
  });

  it('carries a Leave total beside P and A', () => {
    const header = sheet.rows.find((r) => r[0] === 'Roll #');
    expect(header.slice(-4)).toEqual(['P', 'A', 'L', '%']);
  });

  it('rates a child on leave with the student rule: present over every marked day', () => {
    const dana = sheet.rows.find((r) => r[1] === 'Dana Lee');
    expect(dana[2 + 7 - 1]).toBe('L');
    expect(dana.slice(-4)).toEqual([1, 0, 1, '50%']);
  });
});
