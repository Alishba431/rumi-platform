'use strict';
/**
 * When the teacher's class report lands, and what it says about wrong answers.
 *
 * THE TIME. The report is scheduled 12 hours after the first child joins — a
 * share at 09:00 reports the same evening, while the lesson is still fresh. A
 * plain +12 h from an afternoon share lands in the small hours, and a report that
 * buzzes at 3am is worse than one that waits, so a target inside the school's
 * quiet hours moves to the end of them. "The school's" is the point: the clock is
 * SCHOOL_TIMEZONE (config/school-clock.js), never a fixed offset — the same
 * instant is mid-morning in one deployment and the middle of the night in
 * another.
 *
 * THE EXPLANATION. The "why this happens" block reuses feedback authored for the
 * CHILD who got the question wrong ("Nice effort! … Keep learning!"); pasted
 * verbatim into a teacher's report it consoles the teacher for a question they
 * never answered, so the child-facing scaffolding is stripped.
 */

jest.mock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
jest.mock('../../bot/shared/services/whatsapp.service', () => ({
  sendMessage: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
jest.mock('../../bot/shared/utils/structured-logger', () => ({ logEvent: jest.fn() }));

const report = require('../../bot/shared/services/quiz/video-quiz-report.service');
const clock = require('../../bot/shared/config/school-clock');

const HOUR = 3600 * 1000;
const ENV_KEYS = ['SCHOOL_TIMEZONE', 'QUIET_HOURS'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => { delete process.env[k]; });
});
afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
});

describe('the scheduled report: 12 hours after the first join, never in the quiet hours', () => {
  test('a mid-morning share reports the same evening (school time)', () => {
    process.env.SCHOOL_TIMEZONE = 'Africa/Nairobi';          // UTC+3, no daylight saving
    const at = new Date('2026-03-10T05:00:00Z');              // 08:00 in the school
    const t = report.reportTargetUtc(at);
    expect((t - at) / HOUR).toBeCloseTo(12, 5);               // 20:00 in the school
  });

  test('a target inside the quiet hours moves to the end of them, in SCHOOL_TIMEZONE', () => {
    process.env.SCHOOL_TIMEZONE = 'Africa/Nairobi';
    const at = new Date('2026-03-10T08:00:00Z');              // 11:00 → +12 h = 23:00, quiet
    const t = report.reportTargetUtc(at);
    expect(t.toISOString()).toBe('2026-03-11T04:00:00.000Z'); // 07:00 the next school morning
    expect(clock.localHour(t)).toBe(7);
  });

  test('the same instant is NOT moved where it is daytime in the school', () => {
    process.env.SCHOOL_TIMEZONE = 'America/Mexico_City';     // UTC-6 in March 2026
    const at = new Date('2026-03-10T08:00:00Z');              // 02:00 → +12 h = 14:00
    const t = report.reportTargetUtc(at);
    expect((t - at) / HOUR).toBeCloseTo(12, 5);
  });

  test('daylight saving is the zone\'s, not a fixed offset', () => {
    process.env.SCHOOL_TIMEZONE = 'Europe/London';            // BST (UTC+1) in July
    const at = new Date('2026-07-01T11:00:00Z');              // 12:00 → +12 h = 00:00, quiet
    const t = report.reportTargetUtc(at);
    expect(t.toISOString()).toBe('2026-07-02T06:00:00.000Z'); // 07:00 BST
  });

  test('QUIET_HOURS is the school\'s own window', () => {
    process.env.SCHOOL_TIMEZONE = 'Africa/Nairobi';
    process.env.QUIET_HOURS = '22-6';
    const at = new Date('2026-03-10T08:00:00Z');              // → 23:00, quiet until 06:00
    expect(report.reportTargetUtc(at).toISOString()).toBe('2026-03-11T03:00:00.000Z');
    process.env.QUIET_HOURS = 'off';
    expect((report.reportTargetUtc(at) - at) / HOUR).toBeCloseTo(12, 5);
  });

  test('the default school clock is UTC', () => {
    const at = new Date('2026-03-10T08:00:00Z');              // → 20:00 UTC, quiet from 21
    expect((report.reportTargetUtc(at) - at) / HOUR).toBeCloseTo(12, 5);
    const late = new Date('2026-03-10T10:00:00Z');            // → 22:00 UTC, quiet
    expect(report.reportTargetUtc(late).toISOString()).toBe('2026-03-11T07:00:00.000Z');
  });
});

describe('the explanation is written for the TEACHER', () => {
  const strip = report.teacherFacing;

  test('the child-facing opener is removed', () => {
    expect(strip('A) Good try! Fins help swimming, while gills help breathing.'))
      .toBe('Fins help swimming, while gills help breathing.');
  });

  test('the child-facing closer is removed', () => {
    expect(strip('B) Nice effort! Milk and meat are products, not groups. Keep learning!'))
      .toBe('Milk and meat are products, not groups.');
  });

  test('the substance in the middle is never touched', () => {
    const out = strip('C) Good try. You used the monocot rule here: one cotyledon is for '
                      + 'monocots. Correct answer: B) Two, because a dicot seed has two '
                      + 'cotyledons. Keep going!');
    expect(out).toContain('one cotyledon is for monocots');
    expect(out).toContain('a dicot seed has two cotyledons');
    expect(out).not.toMatch(/good try/i);
    expect(out).not.toMatch(/keep going/i);
  });

  test('empty or missing feedback stays null rather than becoming ""', () => {
    expect(strip('A) Good try! Keep going!')).toBeNull();
    expect(strip(null)).toBeNull();
  });
});
