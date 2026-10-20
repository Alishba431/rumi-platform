const Clock = require('../../bot/shared/config/school-clock');

// The school's clock decides the quiz daily cap's "day", when a teacher nudge
// may be sent, and which calendar day a lesson belongs to. It is read from
// SCHOOL_TIMEZONE / QUIET_HOURS on every call, never from a fixed offset.
describe('school-clock', () => {
  const saved = { tz: process.env.SCHOOL_TIMEZONE, quiet: process.env.QUIET_HOURS };
  afterEach(() => {
    if (saved.tz === undefined) delete process.env.SCHOOL_TIMEZONE; else process.env.SCHOOL_TIMEZONE = saved.tz;
    if (saved.quiet === undefined) delete process.env.QUIET_HOURS; else process.env.QUIET_HOURS = saved.quiet;
  });

  it('defaults to UTC and a 21:00-07:00 quiet window', () => {
    delete process.env.SCHOOL_TIMEZONE;
    delete process.env.QUIET_HOURS;
    expect(Clock.timezone()).toBe('UTC');
    expect(Clock.quietWindow()).toEqual({ from: 21, to: 7 });
  });

  it('an unknown timezone falls back to UTC rather than throwing', () => {
    process.env.SCHOOL_TIMEZONE = 'Not/AZone';
    expect(Clock.timezone()).toBe('UTC');
  });

  it('the local date follows the configured zone across midnight', () => {
    const instant = new Date('2026-10-02T20:30:00Z');
    process.env.SCHOOL_TIMEZONE = 'UTC';
    expect(Clock.localDate(instant)).toBe('2026-10-02');
    process.env.SCHOOL_TIMEZONE = 'Africa/Nairobi'; // UTC+3, no DST
    expect(Clock.localDate(instant)).toBe('2026-10-02');
    process.env.SCHOOL_TIMEZONE = 'Asia/Tokyo'; // UTC+9
    expect(Clock.localDate(instant)).toBe('2026-10-03');
    process.env.SCHOOL_TIMEZONE = 'America/Lima'; // UTC-5
    expect(Clock.localDate(new Date('2026-10-03T03:00:00Z'))).toBe('2026-10-02');
  });

  it('a send due inside quiet hours moves to the end of the window, in school time', () => {
    process.env.SCHOOL_TIMEZONE = 'Africa/Nairobi';
    delete process.env.QUIET_HOURS;
    // 22:00 Nairobi = 19:00Z → deferred to 07:00 Nairobi next day = 04:00Z
    expect(Clock.deferOutOfQuiet(new Date('2026-10-02T19:00:00Z')).toISOString()).toBe('2026-10-03T04:00:00.000Z');
    // 03:00 Nairobi = 00:00Z → same-day 07:00 Nairobi
    expect(Clock.deferOutOfQuiet(new Date('2026-10-03T00:00:00Z')).toISOString()).toBe('2026-10-03T04:00:00.000Z');
    // 12:00 Nairobi is outside the window and is left alone
    const noon = new Date('2026-10-02T09:00:00Z');
    expect(Clock.deferOutOfQuiet(noon)).toBe(noon);
  });

  it('QUIET_HOURS=off lifts the window; a custom window is honoured; a typo keeps the default', () => {
    process.env.SCHOOL_TIMEZONE = 'UTC';
    process.env.QUIET_HOURS = 'off';
    expect(Clock.quietWindow()).toBeNull();
    const late = new Date('2026-10-02T23:00:00Z');
    expect(Clock.deferOutOfQuiet(late)).toBe(late);
    process.env.QUIET_HOURS = '13-15';
    expect(Clock.inQuietHours(new Date('2026-10-02T14:00:00Z'))).toBe(true);
    expect(Clock.deferOutOfQuiet(new Date('2026-10-02T14:10:00Z')).toISOString()).toBe('2026-10-02T15:00:00.000Z');
    process.env.QUIET_HOURS = 'nightly';
    expect(Clock.quietWindow()).toEqual({ from: 21, to: 7 });
  });

  it('wall-clock time on a school day converts to the right instant', () => {
    process.env.SCHOOL_TIMEZONE = 'Asia/Tokyo';
    expect(Clock.atLocalTime('2026-10-03', 8, 0).toISOString()).toBe('2026-10-02T23:00:00.000Z');
    process.env.SCHOOL_TIMEZONE = 'Europe/London'; // BST in October before the 25th
    expect(Clock.atLocalTime('2026-10-03', 8, 30).toISOString()).toBe('2026-10-03T07:30:00.000Z');
  });

  it('a bare lesson date is pinned to local noon so no offset moves it to the next day', () => {
    process.env.SCHOOL_TIMEZONE = 'Pacific/Auckland';
    const pinned = Clock.noonOn('2026-10-02');
    expect(Clock.localDate(new Date(pinned))).toBe('2026-10-02');
  });
});
