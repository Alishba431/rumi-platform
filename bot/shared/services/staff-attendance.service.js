/**
 * Staff attendance — the head teacher's register.
 *
 * One keyword, two audiences: a teacher's "attendance" is their class; a head
 * teacher's is the school's staff (attendance-conversation.service routes on the
 * role). This file owns everything the staff side needs that the class side does
 * not: who counts as staff, the one-row-per-person-per-day write, and the month's
 * staff register.
 *
 * Staff are `users` rows linked to the school (`users.school_id`). A colleague who
 * never uses the bot is still staff: a name-only users row (no phone, no channel)
 * puts them on the register. See docs/features/attendance.md for how a deployment
 * links a school.
 *
 * Writes go to teacher_attendance_records — one row per teacher per day, upserted,
 * so re-marking a day overwrites it rather than duplicating.
 */

const supabase = require('../config/supabase');
const { logToFile } = require('../utils/logger');
const AttendanceRegister = require('./attendance-register.service');
const AttendanceDates = require('./attendance-dates');
const { deliverRegisterFile } = require('./attendance-register-delivery.service');

/**
 * Roles that mark staff attendance. `head_teacher` is the one written; `principal`
 * and `school_leader` are read as the same job, for data that already uses them.
 */
const HEAD_TEACHER_ROLES = ['head_teacher', 'principal', 'school_leader'];

const LEAVE_TYPES = ['casual', 'sick', 'official'];

function isHeadTeacher(user) {
  return Boolean(user && HEAD_TEACHER_ROLES.includes(String(user.role || '').toLowerCase()));
}

/** A name-only colleague may have no name yet; a blank row reads as a bug. */
function personName(p) {
  const name = (p.name || '').trim();
  return name || p.phone_number || 'Unnamed';
}

/** The marker's own row, with their role and school. */
async function loadUser(userId) {
  const { data } = await supabase
    .from('users')
    .select('id, name, role, school_id')
    .eq('id', userId)
    .maybeSingle();
  return data || null;
}

async function loadSchool(schoolId) {
  if (!schoolId) return null;
  const { data } = await supabase
    .from('schools')
    .select('id, name, ext_id')
    .eq('id', schoolId)
    .maybeSingle();
  return data || null;
}

/**
 * WHO COUNTS AS STAFF at a school — defined once, here, beside the write.
 *
 * The marking screen, the voice matcher, the register and the write all need this
 * answer; one query is the only way a register's rows can match the screen that
 * filled it. The person marking never appears on their own staff list.
 */
async function loadStaffRoster(schoolId, markerUserId) {
  if (!schoolId) return [];
  const { data } = await supabase
    .from('users')
    .select('id, name, phone_number, role')
    .eq('school_id', schoolId)
    .order('name');
  return (data || []).filter((u) => u.id !== markerUserId);
}

/**
 * Mark the staff for one day.
 *
 * Only people on this school's roster are written: an id that is not (a stale
 * screen, a forged reply) is dropped rather than recorded against another school.
 *
 * @returns {Promise<{replaced: boolean, summary: object}>}
 */
async function markStaffDay({ markerUserId, schoolId, date, staff, records, leaveType = null }) {
  const onRoster = new Set((staff || []).map((s) => s.id));
  const rows = (records || [])
    .filter((r) => onRoster.has(r.studentId))
    .map((r) => ({
      teacher_id: r.studentId,
      school_id: schoolId,
      date,
      status: r.status,
      leave_type: r.status === 'leave' && LEAVE_TYPES.includes(leaveType) ? leaveType : null,
      marked_by_user_id: markerUserId,
      updated_at: new Date().toISOString(),
    }));

  if (!rows.length) throw new Error('Nobody on this school\'s staff list was marked.');

  // Was this day already on file? The upsert cannot tell us afterwards, so ask first —
  // a correction should be acknowledged as one.
  const { data: prior } = await supabase
    .from('teacher_attendance_records')
    .select('teacher_id')
    .eq('school_id', schoolId)
    .eq('date', date)
    .limit(1);
  const replaced = Boolean(prior && prior.length);

  const { error } = await supabase
    .from('teacher_attendance_records')
    .upsert(rows, { onConflict: 'teacher_id,date' });

  if (error) {
    logToFile('❌ Staff attendance upsert failed', { markerUserId, schoolId, error: error.message });
    throw new Error(`Could not save staff attendance: ${error.message}`);
  }

  const summary = {
    total: rows.length,
    present: rows.filter((r) => r.status === 'present').length,
    absent: rows.filter((r) => r.status === 'absent').length,
    leave: rows.filter((r) => r.status === 'leave').length,
  };
  logToFile('✅ Staff attendance saved', { markerUserId, schoolId, date, ...summary, replaced });
  return { replaced, summary };
}

async function loadMonthRecords(schoolId, bounds) {
  const { data, error } = await supabase
    .from('teacher_attendance_records')
    .select('teacher_id, date, status')
    .eq('school_id', schoolId)
    .gte('date', bounds.start)
    .lte('date', bounds.end);
  if (error) {
    logToFile('⚠️ Could not read the month for the staff register', { schoolId, error: error.message });
    return [];
  }
  return data || [];
}

function buildCaption(schoolName, bounds, date, summary, replaced) {
  const dateDisplay = AttendanceDates.formatDisplayDate(date);
  return [
    '📋 *Staff Attendance Register*',
    `🏫 ${schoolName}`,
    `📅 ${AttendanceRegister.MONTH_NAMES[bounds.month - 1]} ${bounds.year}`,
    '',
    replaced ? `${dateDisplay} — updated:` : `${dateDisplay}:`,
    `✅ Present: ${summary.present}`,
    `❌ Absent: ${summary.absent}`,
    `🟡 On leave: ${summary.leave}`,
    '',
    'Approved leave is not counted as absence.',
    'This file holds the whole month so far — the newest copy replaces the last.',
  ].join('\n');
}

/**
 * Save a staff day and deliver the month's staff register.
 *
 * The school is re-read from the marker's own row rather than trusted from the
 * session: a role or school can change between opening the screen and submitting.
 *
 * @param {string} userId       the head teacher
 * @param {string} to           the address they wrote from
 * @param {object} sessionData  { records, sessionDate, markingMethod }
 * @returns {Promise<object>}   the same shape as AttendanceDeliveryService.processAndDeliver
 */
async function saveAndDeliver(userId, to, sessionData) {
  let saved = false;
  try {
    const marker = await loadUser(userId);
    if (!isHeadTeacher(marker) || !marker.school_id) {
      return { success: false, saved, error: 'Staff attendance is marked by a head teacher linked to a school.' };
    }
    const schoolId = marker.school_id;
    const school = await loadSchool(schoolId);
    const schoolName = school?.name || 'Your school';
    const date = AttendanceDates.toDateString(sessionData.sessionDate);

    const staff = await loadStaffRoster(schoolId, userId);
    const { replaced, summary } = await markStaffDay({
      markerUserId: userId, schoolId, date, staff, records: sessionData.records,
    });
    saved = true;

    const bounds = AttendanceDates.monthBounds(date);
    const records = await loadMonthRecords(schoolId, bounds);
    const buffer = await AttendanceRegister.createMonthlyRegisterBuffer(
      { title: schoolName, subject: 'staff' }, bounds.month, bounds.year, staff, records,
    );
    const fileName = AttendanceRegister.formatMonthlyFileName(schoolName, bounds.month, bounds.year, 'staff');
    const caption = buildCaption(schoolName, bounds, date, summary, replaced);

    const delivery = await deliverRegisterFile({
      to,
      buffer,
      fileName,
      caption,
      r2Key: `attendance/staff/${schoolId}/${bounds.year}/${String(bounds.month).padStart(2, '0')}/${fileName}`,
    });

    if (!delivery.sent) {
      return {
        success: false, saved, replaced,
        error: 'Your attendance is saved, but the register file could not be sent on this channel.',
      };
    }
    return { success: true, saved, replaced, fileName, caption, excelUrl: delivery.url };
  } catch (error) {
    logToFile('❌ Staff attendance delivery failed', { userId, saved, error: error.message });
    return { success: false, saved, error: error.message };
  }
}

module.exports = {
  HEAD_TEACHER_ROLES,
  isHeadTeacher,
  personName,
  loadUser,
  loadSchool,
  loadStaffRoster,
  markStaffDay,
  saveAndDeliver,
};
