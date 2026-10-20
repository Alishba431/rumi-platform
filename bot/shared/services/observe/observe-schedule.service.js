/**
 * Observation-schedule store — the coach's "my schedule".
 *
 * Table: observation_schedules. Keyed on (leader_user_id, school_ext_id,
 * teacher_ext_id), exactly ONE 'upcoming' row per key (partial unique index);
 * scheduling again moves it. Ascending scheduled_for lists overdue visits
 * first; each row carries an `overdue` flag for display. markDone retires the
 * matching upcoming row when the observation actually starts (observe-capture)
 * and is deliberately tolerant — a lifecycle miss must never block a capture.
 *
 * A 'done' row is the record of who was observed, so cancel and reschedule
 * only ever touch 'upcoming' rows of the same coach.
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');

const ROW_COLS = 'id, leader_user_id, school_id, school_ext_id, teacher_ext_id, teacher_name, school_name, scheduled_for, scheduled_slot, status, calendar_event_id';

/**
 * The calendar invite is a courtesy ON TOP of the scheduling: lazily required,
 * every call wrapped, never allowed to change what the store returns.
 */
async function _calendar(hook, row) {
  try {
    if (!row) return;
    const Calendar = require('./observe-calendar.service');
    await Calendar[hook](row);
  } catch (err) {
    logToFile('observe-schedule: calendar hook failed (non-blocking)', { hook, scheduleId: row && row.id, error: err.message });
  }
}

/** YYYY-MM-DD and a real day (rejects silently-rolled-over dates like 2026-13-45). */
function isValidDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
}

async function _activeRow(leaderUserId, schoolExtId, teacherExtId) {
  const { data, error } = await supabase
    .from('observation_schedules')
    .select(ROW_COLS)
    .eq('leader_user_id', leaderUserId)
    .eq('school_ext_id', schoolExtId)
    .eq('teacher_ext_id', teacherExtId)
    .eq('status', 'upcoming');
  if (error) throw new Error(`observe-schedule: lookup failed: ${error.message}`);
  return (data && data[0]) || null;
}

/**
 * Create or move THE upcoming visit for a coach × school × teacher.
 * @returns {Promise<object>} the saved row
 */
async function saveSchedule(leaderUserId, {
  school_ext_id, school_id = null, teacher_ext_id, teacher_name, school_name, date, slot,
}) {
  if (!isValidDate(date)) throw new Error(`observe-schedule: invalid date "${date}" (want YYYY-MM-DD)`);
  const existing = await _activeRow(leaderUserId, school_ext_id, teacher_ext_id);
  if (existing) {
    const patch = {
      scheduled_for: date,
      scheduled_slot: slot || null,
      teacher_name: teacher_name || null,
      school_name: school_name || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('observation_schedules').update(patch).eq('id', existing.id);
    if (error) throw new Error(`observe-schedule: update failed: ${error.message}`);
    const moved = { ...existing, ...patch };
    // Re-saving CHANGES the date — creating here would leave two invites for one visit.
    await _calendar('onRescheduled', moved);
    return moved;
  }
  const { data, error } = await supabase
    .from('observation_schedules')
    .insert({
      leader_user_id: leaderUserId,
      school_id,
      school_ext_id,
      teacher_ext_id,
      teacher_name: teacher_name || null,
      school_name: school_name || null,
      scheduled_for: date,
      scheduled_slot: slot || null,
      status: 'upcoming',
    })
    .select()
    .single();
  if (error) throw new Error(`observe-schedule: insert failed: ${error.message}`);
  await _calendar('onScheduled', data);
  return data;
}

/** Upcoming visits, ascending date (overdue first), each with `overdue`. */
async function listUpcoming(leaderUserId, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('observation_schedules')
    .select(ROW_COLS)
    .eq('leader_user_id', leaderUserId)
    .eq('status', 'upcoming')
    .order('scheduled_for', { ascending: true });
  if (error) {
    logToFile('observe-schedule: listUpcoming failed', { leaderUserId, error: error.message });
    return [];
  }
  return (data || [])
    .map((r) => ({ ...r, overdue: r.scheduled_for < today }))
    .sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : a.scheduled_for > b.scheduled_for ? 1 : 0));
}

async function countUpcoming(leaderUserId) {
  try {
    return (await listUpcoming(leaderUserId)).length;
  } catch (_) {
    return 0;
  }
}

/** One of this coach's upcoming visits, or null. */
async function getUpcoming(leaderUserId, scheduleId) {
  const { data, error } = await supabase
    .from('observation_schedules')
    .select(ROW_COLS)
    .eq('id', scheduleId)
    .eq('leader_user_id', leaderUserId)
    .eq('status', 'upcoming')
    .maybeSingle();
  if (error) {
    logToFile('observe-schedule: getUpcoming failed', { leaderUserId, scheduleId, error: error.message });
    return null;
  }
  return data || null;
}

/**
 * The observation started — retire the matching upcoming visit. Tolerant:
 * school-missing falls back to teacher-only; no match / DB error is a no-op.
 */
async function markDone(leaderUserId, teacherExtId, schoolExtId, sessionId) {
  try {
    let q = supabase
      .from('observation_schedules')
      .update({ status: 'done', session_id: sessionId || null, updated_at: new Date().toISOString() })
      .eq('leader_user_id', leaderUserId)
      .eq('teacher_ext_id', teacherExtId)
      .eq('status', 'upcoming');
    if (schoolExtId) q = q.eq('school_ext_id', schoolExtId);
    const { error } = await q;
    if (error) {
      logToFile('observe-schedule: markDone failed (non-blocking)', { leaderUserId, teacherExtId, error: error.message });
    }
  } catch (err) {
    logToFile('observe-schedule: markDone threw (non-blocking)', { leaderUserId, teacherExtId, error: err.message });
  }
}

/** Cancel one upcoming visit. Scoped to the coach and to 'upcoming'. @returns {Promise<boolean>} */
async function cancelById(leaderUserId, scheduleId) {
  const { data, error } = await supabase
    .from('observation_schedules')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', scheduleId)
    .eq('leader_user_id', leaderUserId)
    .eq('status', 'upcoming')
    .select(ROW_COLS);
  if (error) {
    logToFile('observe-schedule: cancelById failed', { leaderUserId, scheduleId, error: error.message });
    return false;
  }
  const cancelled = Array.isArray(data) && data.length > 0;
  // Only a row that actually matched — the same guards stop us deleting someone else's invite.
  if (cancelled) await _calendar('onCancelled', data[0]);
  return cancelled;
}

/** Move one upcoming visit to a new date (and slot). Same guards as cancel. */
async function rescheduleById(leaderUserId, scheduleId, date, slot) {
  if (!isValidDate(date)) throw new Error(`observe-schedule: invalid date "${date}"`);
  const { data, error } = await supabase
    .from('observation_schedules')
    .update({ scheduled_for: date, scheduled_slot: slot || null, updated_at: new Date().toISOString() })
    .eq('id', scheduleId)
    .eq('leader_user_id', leaderUserId)
    .eq('status', 'upcoming')
    .select(ROW_COLS);
  if (error) {
    logToFile('observe-schedule: rescheduleById failed', { leaderUserId, scheduleId, error: error.message });
    return false;
  }
  const moved = Array.isArray(data) && data.length > 0;
  if (moved) await _calendar('onRescheduled', data[0]);
  return moved;
}

module.exports = {
  saveSchedule, listUpcoming, countUpcoming, getUpcoming, markDone, cancelById, rescheduleById, isValidDate,
};
