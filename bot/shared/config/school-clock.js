'use strict';
/**
 * The school's clock — the one place a feature asks "what day / what hour is it
 * for the teacher?".
 *
 * A deployment runs in one timezone (SCHOOL_TIMEZONE, an IANA name such as
 * `Africa/Nairobi`; default `UTC`). Quiz daily caps count per school day, teacher
 * nudges are never sent in the quiet hours, and a lesson recorded at 23:30 belongs
 * to that school day, not the server's. A fixed UTC offset cannot do this for a
 * zone with daylight saving, so every conversion goes through Intl.
 *
 * QUIET_HOURS is `H-H` in school time (default `21-7`, overnight); `off` lifts it
 * (a test environment that has to run a night's scenarios). Anything unreadable
 * keeps the default: a typo must never mean "message teachers at 3am".
 *
 * Both variables are read per call, so a settings change needs no restart.
 */

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_QUIET = Object.freeze({ from: 21, to: 7 });

const formatters = new Map();

function isValidZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/** @returns {string} the configured IANA zone, or UTC when unset or unknown */
function timezone() {
  const raw = String(process.env.SCHOOL_TIMEZONE || '').trim();
  return raw && isValidZone(raw) ? raw : DEFAULT_TIMEZONE;
}

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

/** Wall-clock parts of `date` in the school zone. */
function localParts(date = new Date(), tz = timezone()) {
  const out = {};
  for (const p of formatterFor(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Minutes the school zone is ahead of UTC at `date` (negative west of Greenwich). */
function offsetMinutes(date = new Date(), tz = timezone()) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` of `date` in the school zone. */
function localDate(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The hour (0-23) of `date` in the school zone. */
function localHour(date = new Date()) {
  return localParts(date).hour;
}

/**
 * The instant at which the school's wall clock reads `hour:minute` on `ymd`.
 * Two passes, because the offset at the guess can differ from the offset at the
 * answer when a daylight-saving change falls between them.
 */
function atLocalTime(ymd, hour = 0, minute = 0) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const tz = timezone();
  const wall = Date.UTC(y, m - 1, d, hour, minute, 0);
  let t = wall - offsetMinutes(new Date(wall), tz) * 60000;
  t = wall - offsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

/** ISO instant of local noon on `ymd`: a bare lesson date pinned where no offset can move it a day. */
function noonOn(ymd) {
  return atLocalTime(ymd, 12, 0).toISOString();
}

/** @returns {{from:number,to:number}|null} null = no quiet window */
function quietWindow() {
  const raw = String(process.env.QUIET_HOURS || '').trim().toLowerCase();
  if (raw === 'off') return null;
  const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (m) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (from <= 23 && to <= 23 && from !== to) return { from, to };
  }
  return { ...DEFAULT_QUIET };
}

function inQuietHours(date = new Date()) {
  const w = quietWindow();
  if (!w) return false;
  const h = localHour(date);
  return w.from > w.to ? (h >= w.from || h < w.to) : (h >= w.from && h < w.to);
}

/**
 * When something due at `when` may be sent: `when` itself outside the quiet
 * window, else the window's end (the next `to:00` in school time). Deferred,
 * never dropped.
 */
function deferOutOfQuiet(when = new Date()) {
  if (!inQuietHours(when)) return when;
  const w = quietWindow();
  const today = localDate(when);
  let target = atLocalTime(today, w.to, 0);
  if (target.getTime() <= when.getTime()) {
    const next = new Date(atLocalTime(today, 12, 0).getTime() + 24 * 60 * 60 * 1000);
    target = atLocalTime(localDate(next), w.to, 0);
  }
  return target;
}

module.exports = {
  DEFAULT_TIMEZONE,
  timezone,
  localParts,
  offsetMinutes,
  localDate,
  localHour,
  atLocalTime,
  noonOn,
  quietWindow,
  inQuietHours,
  deferOutOfQuiet,
};
