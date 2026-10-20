'use strict';
/**
 * The deployment's local clock, for teacher nudges.
 *
 * A nudge is "one per teacher per local day", and it must not land in the
 * middle of the night. Both questions are about the teachers' wall clock, not
 * the server's, so both are answered here from two settings:
 *
 *   TEACHER_NUDGES_TZ           an IANA zone name (blank: ATTENDANCE_TZ, else `UTC`). Resolved with
 *                               Intl.DateTimeFormat, so daylight saving is
 *                               handled by the platform's tz database — there is
 *                               no hard-coded offset anywhere.
 *   TEACHER_NUDGES_QUIET_HOURS  `H-H` in local hours, start inclusive, end
 *                               exclusive (default `21-7`: 21:00 up to 06:59).
 *                               A window may wrap midnight. Empty, `off` or
 *                               `none` means no quiet hours.
 *
 * Both are read at call time. A malformed value never throws: an unknown zone
 * reads as UTC and an unparseable quiet window keeps the default, because the
 * safe failure for a scheduled message is "too careful", not "3 a.m.".
 */

const DEFAULT_TZ = 'UTC';
const DEFAULT_QUIET = Object.freeze({ start: 21, end: 7 });

const formatters = new Map();

function isValidZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_error) {
    return false;
  }
}

/** The configured IANA zone, or UTC when unset or unknown. */
function timeZone() {
  // One clock for the school: blank falls back to the attendance timezone.
  const raw = String(process.env.TEACHER_NUDGES_TZ || process.env.ATTENDANCE_TZ || '').trim();
  if (!raw) return DEFAULT_TZ;
  return isValidZone(raw) ? raw : DEFAULT_TZ;
}

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return formatters.get(tz);
}

/** { year, month, day, hour, minute } of `at` on the local wall clock. */
function localParts(at = new Date()) {
  const date = at instanceof Date ? at : new Date(at);
  const parts = {};
  for (const p of formatterFor(timeZone()).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Some engines spell local midnight "24" even with h23; normalise it.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The local calendar date, `YYYY-MM-DD` — the `nudge_date` of a row booked at `at`. */
function localDate(at = new Date()) {
  const p = localParts(at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The local hour, 0-23. */
function localHour(at = new Date()) {
  return localParts(at).hour;
}

/**
 * The quiet window as `{ start, end }` local hours, or null for none.
 */
function quietHours() {
  const raw = process.env.TEACHER_NUDGES_QUIET_HOURS;
  if (raw === undefined) return { ...DEFAULT_QUIET };
  const value = String(raw).trim().toLowerCase();
  if (value === '' || value === 'off' || value === 'none') return null;

  const match = value.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) return { ...DEFAULT_QUIET };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 24) return { ...DEFAULT_QUIET };
  if (start === end % 24) return null; // a zero-length window is no window
  return { start, end: end % 24 };
}

/** Is `at` inside the quiet window, on the local clock? */
function isQuietHour(at = new Date()) {
  const window = quietHours();
  if (!window) return false;
  const hour = localHour(at);
  if (window.start < window.end) return hour >= window.start && hour < window.end;
  return hour >= window.start || hour < window.end; // wraps midnight
}

module.exports = {
  DEFAULT_TZ,
  DEFAULT_QUIET,
  timeZone,
  localParts,
  localDate,
  localHour,
  quietHours,
  isQuietHour,
};
