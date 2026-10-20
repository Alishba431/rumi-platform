/**
 * Which day a mark belongs to, and which month a register holds.
 *
 * Two shipped bugs are the reason this module works on 'YYYY-MM-DD' strings: a
 * register a column off west of UTC, and a month query whose last day fell out east
 * of it. And "today" is the school's today (ATTENDANCE_TZ), not the server's.
 */

const dates = require('../../bot/shared/services/attendance-dates');

// 2026-10-02 10:00 UTC — a Friday.
const NOW = new Date('2026-10-02T10:00:00Z');

afterEach(() => {
  delete process.env.ATTENDANCE_TZ;
  delete process.env.ATTENDANCE_MAX_BACKDATE_DAYS;
});

describe('today, for the school', () => {
  it('is the UTC day by default', () => {
    expect(dates.todayString(new Date('2026-10-01T23:30:00Z'))).toBe('2026-10-01');
  });

  it('is the local day in ATTENDANCE_TZ — a teacher marking at 08:00 is not filed under yesterday', () => {
    process.env.ATTENDANCE_TZ = 'Asia/Tokyo';
    expect(dates.todayString(new Date('2026-10-01T23:30:00Z'))).toBe('2026-10-02');
  });

  it('falls back to UTC for a zone that does not exist', () => {
    process.env.ATTENDANCE_TZ = 'Not/AZone';
    expect(dates.attendanceTimeZone()).toBe('UTC');
  });
});

describe('month bounds', () => {
  it('covers the whole month including its last day', () => {
    expect(dates.monthBounds('2026-09-14')).toEqual({ year: 2026, month: 9, start: '2026-09-01', end: '2026-09-30' });
  });

  it('gets February right in and out of a leap year', () => {
    expect(dates.monthBounds('2026-02-10').end).toBe('2026-02-28');
    expect(dates.monthBounds('2028-02-10').end).toBe('2028-02-29');
  });
});

describe('toDateString', () => {
  it('trusts a date string as written', () => {
    expect(dates.toDateString('2026-09-30')).toBe('2026-09-30');
  });

  it('defaults to today', () => {
    expect(dates.toDateString(undefined, NOW)).toBe('2026-10-02');
  });
});

describe('the day named in a request', () => {
  it('is null when no day is named', () => {
    expect(dates.parseRequestedDate('attendance', NOW)).toBeNull();
  });

  it.each([
    ['attendance yesterday', '2026-10-01'],
    ['attendance today', '2026-10-02'],
    ['attendance 2026-09-30', '2026-09-30'],
    ['attendance 30 sep', '2026-09-30'],
    ['attendance 30th September', '2026-09-30'],
    ['attendance sep 30', '2026-09-30'],
    ['attendance 30/9', '2026-09-30'],
    ['attendance 1 oct', '2026-10-01'],
  ])('%s → %s', (text, expected) => {
    expect(dates.parseRequestedDate(text, NOW)).toEqual({ date: expected });
  });

  it('reads a day-month that would be ahead of today as last year', () => {
    expect(dates.parseRequestedDate('attendance 30 dec', NOW)).toEqual({ error: 'too_old', maxBack: 62 });
    process.env.ATTENDANCE_MAX_BACKDATE_DAYS = '400';
    expect(dates.parseRequestedDate('attendance 30 dec', NOW)).toEqual({ date: '2025-12-30' });
  });

  it('refuses a future day rather than guessing', () => {
    expect(dates.parseRequestedDate('attendance 2026-10-05', NOW)).toEqual({ error: 'future' });
  });

  it('refuses a day that does not exist', () => {
    expect(dates.parseRequestedDate('attendance 2026-02-30', NOW)).toEqual({ error: 'invalid' });
  });
});

describe('formatDisplayDate', () => {
  it('reads back the day in words', () => {
    expect(dates.formatDisplayDate('2026-09-30')).toBe('Wednesday 30 September 2026');
  });
});

describe('the academic year', () => {
  afterEach(() => { delete process.env.ATTENDANCE_ACADEMIC_YEAR_START_MONTH; });

  it('starts in April by default — the behaviour existing installs already have', () => {
    expect(dates.academicYear(new Date('2026-03-15T12:00:00Z'))).toBe('2025-2026');
    expect(dates.academicYear(new Date('2026-04-01T12:00:00Z'))).toBe('2026-2027');
  });

  it('starts in the month a deployment configures', () => {
    process.env.ATTENDANCE_ACADEMIC_YEAR_START_MONTH = '9';
    expect(dates.academicYear(new Date('2026-08-31T12:00:00Z'))).toBe('2025-2026');
    expect(dates.academicYear(new Date('2026-09-01T12:00:00Z'))).toBe('2026-2027');
  });

  it('a calendar-year school (January start) is one year, still written as a pair', () => {
    process.env.ATTENDANCE_ACADEMIC_YEAR_START_MONTH = '1';
    expect(dates.academicYear(new Date('2026-06-01T12:00:00Z'))).toBe('2026-2027');
  });
});
