/**
 * The cumulative monthly register — the document a school actually keeps.
 *
 * One row per person, one column per day, running totals on the right, weekends
 * greyed, and a third status: approved Leave. A register that only knows P and A
 * files a colleague's approved leave as absence.
 *
 * The same builder serves both registers, and the two compute the rate differently:
 *   staff    present / (present + absent)          leave is excused
 *   student  present / (present + absent + leave)  a child on leave was not in the room
 */

jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

const register = require('../../bot/shared/services/attendance-register.service');

const STAFF = [
  { id: 'u1', name: 'Amara Okafor' },
  { id: 'u2', name: 'Ben Ito' },
  { id: 'u3', name: 'Chen Rao' },
];

// August 2026: the 3rd is a Monday, the 8th a Saturday.
const RECORDS = [
  { teacher_id: 'u1', date: '2026-08-03', status: 'present' },
  { teacher_id: 'u2', date: '2026-08-03', status: 'absent' },
  { teacher_id: 'u3', date: '2026-08-03', status: 'leave' },
  { teacher_id: 'u1', date: '2026-08-04', status: 'present' },
  { teacher_id: 'u2', date: '2026-08-04', status: 'present' },
  { teacher_id: 'u3', date: '2026-08-04', status: 'absent' },
];

/** The recording exceljs stub serialises the worksheets into the buffer. */
function sheetsOf(buffer) {
  return JSON.parse(buffer.toString());
}

describe('the matrix', () => {
  it('places each person on each day they have a record', () => {
    const m = register.buildMatrix(STAFF, RECORDS);
    expect(m.u1.days[3]).toBe('P');
    expect(m.u2.days[3]).toBe('A');
    expect(m.u3.days[3]).toBe('L');
    expect(m.u3.days[4]).toBe('A');
  });

  it('leaves an unmarked day blank rather than assuming anything', () => {
    const m = register.buildMatrix(STAFF, RECORDS);
    expect(m.u1.days[5]).toBeUndefined();
  });

  it('includes a person with no records at all', () => {
    const m = register.buildMatrix([...STAFF, { id: 'u9', name: 'New Joiner' }], RECORDS);
    expect(m.u9).toBeDefined();
    expect(Object.keys(m.u9.days)).toEqual([]);
  });

  it('reads the day off the date string, so a negative UTC offset cannot shift a column', () => {
    // new Date('2026-08-03') is midnight UTC; .getDate() in UTC-5 is the 2nd.
    const m = register.buildMatrix(STAFF, [{ teacher_id: 'u1', date: '2026-08-03', status: 'present' }]);
    expect(m.u1.days[3]).toBe('P');
    expect(m.u1.days[2]).toBeUndefined();
  });

  it('reads a legacy "excused" record as Leave, so rows written before Leave existed keep their meaning', () => {
    const m = register.buildMatrix(STAFF, [{ teacher_id: 'u1', date: '2026-08-03', status: 'excused' }]);
    expect(m.u1.days[3]).toBe('L');
  });
});

describe('the per-person totals', () => {
  it('counts present, absent and leave separately', () => {
    const s = register.monthlyStats({ 3: 'P', 4: 'A', 5: 'L', 6: 'P' });
    expect(s).toMatchObject({ present: 2, absent: 1, leave: 1 });
  });

  it('rates attendance over the days actually marked, not the whole month', () => {
    expect(register.monthlyStats({ 3: 'P', 4: 'A' }).percentage).toBe(50);
  });

  it('for staff, approved leave is neither present nor absent', () => {
    expect(register.monthlyStats({ 3: 'P', 4: 'A', 5: 'L' }, { subject: 'staff' }).percentage).toBe(50);
    expect(register.monthlyStats({ 4: 'P', 7: 'L' }, { subject: 'staff' }).percentage).toBe(100);
  });

  it('for a child, a leave day is a marked day they were not in the room', () => {
    const s = register.monthlyStats({ 4: 'P', 7: 'L' }, { subject: 'student' });
    expect(s).toMatchObject({ present: 1, absent: 0, leave: 1 });
    expect(s.percentage).toBe(50);
    expect(register.monthlyStats({ 3: 'P', 4: 'A', 5: 'L' }, { subject: 'student' }).percentage).toBe(33);
  });

  it('does not divide by zero for someone never marked', () => {
    expect(register.monthlyStats({}).percentage).toBe(0);
    expect(register.monthlyStats({ 3: 'L' }, { subject: 'student' }).percentage).toBe(0);
  });
});

describe('weekends', () => {
  it('knows which days of August 2026 are weekends', () => {
    const w = register.getWeekendDays(2026, 8);
    expect(w).toContain(8);
    expect(w).toContain(9);
    expect(w).not.toContain(10);
  });
});

describe('the filename', () => {
  it('names the school and the month for the staff register', () => {
    expect(register.formatMonthlyFileName('Hillside Primary', 8, 2026, 'staff'))
      .toBe('Staff_Attendance_Hillside_Primary_August_2026.xlsx');
  });

  it('names the class and the month for a class register', () => {
    expect(register.formatMonthlyFileName('Grade 5 - A', 8, 2026, 'student'))
      .toBe('Attendance_Grade_5_A_August_2026.xlsx');
  });

  it('survives a name full of punctuation', () => {
    expect(register.formatMonthlyFileName('St. Mark\'s #4 (Girls)/East', 8, 2026, 'staff'))
      .toMatch(/^Staff_Attendance_[A-Za-z0-9_]+_August_2026\.xlsx$/);
  });
});

describe('the staff workbook', () => {
  let sheet;

  beforeAll(async () => {
    const buffer = await register.createMonthlyRegisterBuffer(
      { title: 'Hillside Primary', subject: 'staff' }, 8, 2026, STAFF, RECORDS,
    );
    [sheet] = sheetsOf(buffer);
  });

  it('is one sheet named for staff', () => {
    expect(sheet.name).toBe('Staff Register');
  });

  it('names the school and the month in the header', () => {
    const text = sheet.rows.flat().map((v) => String(v ?? '')).join(' ');
    expect(text).toContain('Hillside Primary');
    expect(text).toContain('August 2026');
  });

  it('has a column for every day of the month, plus P, A, L and %', () => {
    const widest = Math.max(...sheet.rows.map((r) => r.length));
    expect(widest).toBe(1 + 31 + 4);
  });

  it('has one row per person, in roster order, with P, A and L in the day cells', () => {
    const rows = sheet.rows.filter((r) => /Okafor|Ito|Rao/.test(String(r[0])));
    expect(rows.map((r) => r[0])).toEqual(['Amara Okafor', 'Ben Ito', 'Chen Rao']);
    expect(rows[2][3]).toBe('L');
    expect(rows[0][5]).toBe('-');
  });

  it('carries the running totals on the right', () => {
    const chen = sheet.rows.find((r) => r[0] === 'Chen Rao');
    // P 0, A 1, L 1 — and the staff rate excuses the leave: 0 / 1.
    expect(chen.slice(-4)).toEqual([0, 1, 1, '0%']);
  });

  it('puts the day numbers and weekday names above the grid', () => {
    const dayHeader = sheet.rows.find((r) => r[0] === 'Name');
    expect(dayHeader[1]).toBe('1');
    expect(dayHeader.slice(-4)).toEqual(['P', 'A', 'L', '%']);
    const weekdays = sheet.rows[sheet.rows.indexOf(dayHeader) + 1];
    expect(weekdays[3]).toBe('Mon');
    expect(weekdays[8]).toBe('Sat');
  });
});

describe('the class workbook', () => {
  it('leads with the roll number and uses the student rate end to end', async () => {
    const people = [{ id: 'k1', student_name: 'Dana Lee', roll_number: 8 }];
    const records = [
      { student_id: 'k1', date: '2026-09-04', status: 'present' },
      { student_id: 'k1', date: '2026-09-07', status: 'leave' },
    ];
    const buffer = await register.createMonthlyRegisterBuffer(
      { title: 'Grade 5 - A', subject: 'student' }, 9, 2026, people, records,
    );
    const sheet = sheetsOf(buffer).find((w) => w.name === 'Class Register');
    const row = sheet.rows.find((r) => r[1] === 'Dana Lee');
    expect(row[0]).toBe(8);
    expect(row[row.length - 1]).toBe('50%');
  });
});
