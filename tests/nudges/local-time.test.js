'use strict';
/**
 * local-time.js — the deployment's local calendar day and quiet hours, from
 * TEACHER_NUDGES_TZ (an IANA name, via Intl — no hard-coded offset, so
 * daylight-saving zones are right) and TEACHER_NUDGES_QUIET_HOURS.
 *
 * Fixed instants only; nothing reads the wall clock.
 */

const localTime = require('../../bot/shared/services/nudges/local-time');

const ENV_KEYS = ['TEACHER_NUDGES_TZ', 'TEACHER_NUDGES_QUIET_HOURS'];
const saved = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('local-time — the deployment calendar', () => {
  it('defaults to UTC', () => {
    expect(localTime.timeZone()).toBe('UTC');
    expect(localTime.localDate(new Date('2026-03-10T23:30:00Z'))).toBe('2026-03-10');
    expect(localTime.localHour(new Date('2026-03-10T23:30:00Z'))).toBe(23);
  });

  it('uses the IANA zone in TEACHER_NUDGES_TZ for the local day and hour', () => {
    process.env.TEACHER_NUDGES_TZ = 'Asia/Tokyo'; // UTC+9, no DST
    const at = new Date('2026-03-10T20:30:00Z');
    expect(localTime.localDate(at)).toBe('2026-03-11');
    expect(localTime.localHour(at)).toBe(5);
  });

  it('follows daylight saving (no fixed offset)', () => {
    process.env.TEACHER_NUDGES_TZ = 'America/New_York';
    // Winter: UTC-5. Summer: UTC-4.
    expect(localTime.localHour(new Date('2026-01-15T12:00:00Z'))).toBe(7);
    expect(localTime.localHour(new Date('2026-07-15T12:00:00Z'))).toBe(8);
  });

  it('falls back to UTC for an unknown zone rather than throwing', () => {
    process.env.TEACHER_NUDGES_TZ = 'Not/AZone';
    expect(localTime.timeZone()).toBe('UTC');
    expect(localTime.localDate(new Date('2026-03-10T23:30:00Z'))).toBe('2026-03-10');
  });
});

describe('local-time — quiet hours', () => {
  const at = (hourUtc) => new Date(`2026-03-10T${String(hourUtc).padStart(2, '0')}:15:00Z`);

  it('defaults to 21-7 (wrapping midnight): 21:00 up to 06:59 is quiet', () => {
    expect(localTime.quietHours()).toEqual({ start: 21, end: 7 });
    expect(localTime.isQuietHour(at(21))).toBe(true);
    expect(localTime.isQuietHour(at(23))).toBe(true);
    expect(localTime.isQuietHour(at(0))).toBe(true);
    expect(localTime.isQuietHour(at(6))).toBe(true);
    expect(localTime.isQuietHour(at(7))).toBe(false);
    expect(localTime.isQuietHour(at(12))).toBe(false);
    expect(localTime.isQuietHour(at(20))).toBe(false);
  });

  it('reads TEACHER_NUDGES_QUIET_HOURS, including a window that does not wrap', () => {
    process.env.TEACHER_NUDGES_QUIET_HOURS = '12-14';
    expect(localTime.isQuietHour(at(11))).toBe(false);
    expect(localTime.isQuietHour(at(12))).toBe(true);
    expect(localTime.isQuietHour(at(13))).toBe(true);
    expect(localTime.isQuietHour(at(14))).toBe(false);
  });

  it.each(['', 'off', 'none'])('%j means no quiet hours at all', (v) => {
    process.env.TEACHER_NUDGES_QUIET_HOURS = v;
    expect(localTime.quietHours()).toBeNull();
    expect(localTime.isQuietHour(at(23))).toBe(false);
  });

  it('a malformed value keeps the safe default instead of switching quiet hours off', () => {
    process.env.TEACHER_NUDGES_QUIET_HOURS = 'late-evening';
    expect(localTime.quietHours()).toEqual({ start: 21, end: 7 });
  });

  it('judges quiet hours in the configured zone', () => {
    process.env.TEACHER_NUDGES_TZ = 'Asia/Tokyo';
    // 13:15 UTC is 22:15 in Tokyo.
    expect(localTime.isQuietHour(at(13))).toBe(true);
    // 01:15 UTC is 10:15 in Tokyo.
    expect(localTime.isQuietHour(at(1))).toBe(false);
  });
});

describe('local-time — one clock for the school', () => {
  afterEach(() => { delete process.env.ATTENDANCE_TZ; });

  it('falls back to ATTENDANCE_TZ when TEACHER_NUDGES_TZ is blank', () => {
    process.env.ATTENDANCE_TZ = 'Asia/Tokyo';
    expect(localTime.timeZone()).toBe('Asia/Tokyo');
  });

  it('TEACHER_NUDGES_TZ still wins when both are set', () => {
    process.env.ATTENDANCE_TZ = 'Asia/Tokyo';
    process.env.TEACHER_NUDGES_TZ = 'America/New_York';
    expect(localTime.timeZone()).toBe('America/New_York');
  });
});
