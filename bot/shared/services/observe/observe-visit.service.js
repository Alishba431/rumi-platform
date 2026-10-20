'use strict';
/**
 * The visit picker and the coach's schedule — in chat, on every channel.
 *
 *   picker   school → teacher → (mode)
 *              o  observe now: brief card, then the recording slot is armed
 *                 with the teacher bound, so the capture is theirs
 *              p  plan a visit: pick a school day (or type a date) → saved
 *              b  bind a parked recording: the teacher is armed and the oldest
 *                 parked recording is captured for them (observe-binding)
 *   schedule "My schedule": upcoming visits, overdue first; each one can be
 *            started (binds the teacher, like the picker), moved or cancelled
 *
 * Ids (all routed in observe-interactive.handler.js):
 *   observe_vs_<mode>_<schoolId>            school row
 *   observe_vsmore_<mode>_<page>            next page of schools
 *   observe_vt_<mode>_<teacherUserId>       teacher row
 *   observe_vtmore_<mode>_<schoolId>_<page> next page of teachers
 *   observe_vskip                           "not listed — record" (bare capture)
 *   observe_vd_<target>_<YYYY-MM-DD>        a day; target t<teacherId> | s<scheduleId>
 *   observe_vdtype_<target>                 "type a date" (arms awaiting_visit_date)
 *   observe_sched_<id> / observe_schedmore_<page>
 *   observe_sstart_<id> / observe_smove_<id> / observe_scancel_<id>
 *
 * Ids carry only a reference: every tap re-reads the coach's own roster or
 * schedule, so a stale or forged id can never bind a teacher who is not theirs.
 */

const WhatsAppService = require('../whatsapp.service');
const ObserveState = require('./observe-state.service');
const Roster = require('./observe-roster.service');
const ScheduleStore = require('./observe-schedule.service');
const { t, observeLang } = require('./observe-strings');
const { row, pageOf, listPayload, fmtDay, today } = require('./observe-list');
const { logToFile } = require('../../utils/logger');

const MODES = new Set(['o', 'p', 'b']);
const DATE_STATE = 'awaiting_visit_date';
const PICK_STATE = 'awaiting_pick';
const DAYS_OFFERED = 6;

const { schoolKeyOf: schoolKey, boundTeacherOf } = Roster;

/** Plain capture: ask for the recording and arm the slot (no teacher bound). */
async function sendBareCapture(user, from) {
  await WhatsAppService.sendMessage(from, t(observeLang(user), 'capture_prompt'));
  await ObserveState.setState(user.id, 'awaiting_audio');
  return true;
}

// ── picker ───────────────────────────────────────────────────────────────

async function startPicker(user, from, mode = 'o') {
  return sendSchools(user, from, mode, 0);
}

async function sendSchools(user, from, mode, page = 0) {
  const lang = observeLang(user);
  const schools = await Roster.listSchools(user.id);
  if (!schools.length) {
    await WhatsAppService.sendMessage(from, t(lang, 'pick_no_schools'));
    return true;
  }
  // One school: nothing to choose — straight to its teachers.
  if (schools.length === 1 && page === 0) return sendTeachers(user, from, mode, schools[0].id, 0);
  const { items, hasMore } = pageOf(schools, page, 0);
  const rows = items.map((s) => row(`observe_vs_${mode}_${s.id}`, s.name, s.ext_id || ''));
  if (hasMore) rows.push(row(`observe_vsmore_${mode}_${page + 1}`, t(lang, 'menu_more'), t(lang, 'menu_more_desc')));
  await WhatsAppService.sendInteractiveMessage(from, listPayload(
    t(lang, `pick_school_body_${mode}`), t(lang, 'pick_school_button'),
    [{ title: t(lang, 'pick_school_section'), rows }],
  ));
  return true;
}

async function sendTeachers(user, from, mode, schoolId, page = 0) {
  const lang = observeLang(user);
  const schools = await Roster.listSchools(user.id);
  const school = schools.find((s) => s.id === schoolId);
  if (!school) {
    await WhatsAppService.sendMessage(from, t(lang, 'pick_stale'));
    return true;
  }
  const teachers = await Roster.listTeachers(user.id, { schoolId });
  // Observing (or binding) someone who is not on the list must still be possible.
  const fixed = mode === 'p' ? [] : [row('observe_vskip', t(lang, 'pick_teacher_skip'), t(lang, 'pick_teacher_skip_desc'))];
  if (!teachers.length && !fixed.length) {
    await WhatsAppService.sendMessage(from, t(lang, 'pick_no_teachers', { school: school.name }));
    return true;
  }
  const { items, hasMore } = pageOf(teachers, page, fixed.length);
  const rows = items.map((tc) => row(`observe_vt_${mode}_${tc.user_id}`, tc.name, school.name));
  rows.push(...fixed);
  if (hasMore) rows.push(row(`observe_vtmore_${mode}_${schoolId}_${page + 1}`, t(lang, 'pick_teacher_more'), t(lang, 'menu_more_desc')));
  await WhatsAppService.sendInteractiveMessage(from, listPayload(
    t(lang, 'pick_teacher_body_v', { school: school.name }), t(lang, 'pick_teacher_button'),
    [{ title: t(lang, 'pick_teacher_section_v'), rows }],
  ));
  return true;
}

/** `<mode>_<rest>` → { mode, rest } or null. */
function _splitMode(s) {
  const m = /^([a-z])_(.+)$/.exec(String(s || ''));
  return m && MODES.has(m[1]) ? { mode: m[1], rest: m[2] } : null;
}

async function onSchoolTap(user, from, rest) {
  const p = _splitMode(rest);
  if (!p) return false;
  return sendTeachers(user, from, p.mode, p.rest, 0);
}

async function onSchoolMoreTap(user, from, rest) {
  const p = _splitMode(rest);
  if (!p || !/^\d+$/.test(p.rest)) return false;
  return sendSchools(user, from, p.mode, parseInt(p.rest, 10));
}

async function onTeacherMoreTap(user, from, rest) {
  const p = _splitMode(rest);
  if (!p) return false;
  const cut = p.rest.lastIndexOf('_');
  if (cut <= 0) return false;
  return sendTeachers(user, from, p.mode, p.rest.slice(0, cut), parseInt(p.rest.slice(cut + 1), 10) || 0);
}

/** One of THIS coach's teachers, or null. */
async function findTeacher(user, teacherUserId) {
  const teachers = await Roster.listTeachers(user.id);
  return teachers.find((tc) => tc.user_id === teacherUserId) || null;
}

/** Bind the teacher, then the brief and the "record now" line. */
async function armAndBrief(user, from, teacher, schoolExtId) {
  const lang = observeLang(user);
  await ObserveState.setState(user.id, 'awaiting_audio', { boundTeacher: boundTeacherOf(teacher, schoolExtId) });
  const Brief = require('./observe-brief-card');
  await WhatsAppService.sendMessage(from, await Brief.briefFor(lang, teacher));
  await WhatsAppService.sendMessage(from, t(lang, 'brief_record', { name: teacher.name }));
  logToFile('🔭 observe-visit: teacher bound for the next recording', { userId: user.id, teacherId: teacher.user_id });
  return true;
}

async function onTeacherTap(user, from, rest) {
  const p = _splitMode(rest);
  if (!p) return false;
  const lang = observeLang(user);
  const teacher = await findTeacher(user, p.rest);
  if (!teacher) {
    await WhatsAppService.sendMessage(from, t(lang, 'pick_stale'));
    return true;
  }
  if (p.mode === 'p') return sendDatePicker(user, from, `t${teacher.user_id}`, teacher.name);
  if (p.mode === 'b') {
    const Binding = require('./observe-binding.service');
    return Binding.bindTeacher(user, from, { token: await _bindToken(user), boundTeacher: boundTeacherOf(teacher) });
  }
  return armAndBrief(user, from, teacher);
}

/** The parked recording the picker is binding (armed by startBindPicker), or null. */
async function _bindToken(user) {
  const st = await ObserveState.getState(user.id);
  return st && st.state === PICK_STATE && st.bindToken ? st.bindToken : null;
}

/**
 * "Another teacher" on the binding question: the picker in bind mode, for
 * exactly that parked recording.
 */
async function startBindPicker(user, from, token) {
  const Binding = require('./observe-binding.service');
  // Not the recording at the head any more: let the binding answer (dupe / expired).
  if ((await Binding.headToken(user.id)) !== token) return Binding.bindTeacher(user, from, { token });
  await ObserveState.setState(user.id, PICK_STATE, { bindToken: token });
  return sendSchools(user, from, 'b', 0);
}

/** "Not listed — record": a bare capture; in bind mode, the parked recording unbound. */
async function onSkipTap(user, from) {
  const token = await _bindToken(user);
  if (token) return require('./observe-binding.service').bindTeacher(user, from, { token, boundTeacher: null });
  return sendBareCapture(user, from);
}

// ── dates ───────────────────────────────────────────────────────────────

/** ISO weekdays (1 = Monday … 7 = Sunday) that are school days. Default Mon–Fri. */
function schoolDays() {
  const raw = String(process.env.OBSERVE_SCHOOL_DAYS || '').trim();
  const days = raw ? raw.split(',').map((d) => parseInt(d.trim(), 10)).filter((d) => d >= 1 && d <= 7) : [];
  return new Set(days.length ? days : [1, 2, 3, 4, 5]);
}

/** The next `n` school days from today (inclusive), as YYYY-MM-DD. */
function nextSchoolDays(n = DAYS_OFFERED, from = today()) {
  const allowed = schoolDays();
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let i = 0; out.length < n && i < 31; i += 1) {
    const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (allowed.has(iso)) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function sendDatePicker(user, from, target, name) {
  const lang = observeLang(user);
  const rows = nextSchoolDays().map((day) => row(`observe_vd_${target}_${day}`, fmtDay(day), day));
  rows.push(row(`observe_vdtype_${target}`, t(lang, 'date_type_row'), t(lang, 'date_type_desc')));
  await WhatsAppService.sendInteractiveMessage(from, listPayload(
    t(lang, 'date_body', { name: name || '' }), t(lang, 'date_button'),
    [{ title: t(lang, 'date_section'), rows }],
  ));
  return true;
}

/** Save (t<teacherId>) or move (s<scheduleId>) a visit to `date`. */
async function applyDate(user, from, target, date) {
  const lang = observeLang(user);
  try {
    if (target.startsWith('s')) {
      const visit = await ScheduleStore.getUpcoming(user.id, target.slice(1));
      if (!visit || !(await ScheduleStore.rescheduleById(user.id, visit.id, date))) {
        await WhatsAppService.sendMessage(from, t(lang, 'sched_gone'));
        return true;
      }
      await WhatsAppService.sendMessage(from, t(lang, 'date_moved', { name: visit.teacher_name || '', date: fmtDay(date) }));
      return true;
    }
    const teacher = await findTeacher(user, target.slice(1));
    if (!teacher) {
      await WhatsAppService.sendMessage(from, t(lang, 'pick_stale'));
      return true;
    }
    await ScheduleStore.saveSchedule(user.id, {
      school_ext_id: schoolKey(teacher),
      school_id: teacher.school_id,
      teacher_ext_id: teacher.teacher_ext_id,
      teacher_name: teacher.name,
      school_name: teacher.school_name,
      date,
    });
    await WhatsAppService.sendMessage(from, t(lang, 'date_saved', { name: teacher.name, date: fmtDay(date) }));
  } catch (err) {
    logToFile('❌ observe-visit: could not save the visit', { userId: user.id, target, date, error: err.message });
    await WhatsAppService.sendMessage(from, t(lang, 'date_failed'));
  }
  return true;
}

function _parseDateTap(rest) {
  const cut = String(rest || '').lastIndexOf('_');
  if (cut <= 1) return null;
  const target = rest.slice(0, cut);
  const date = rest.slice(cut + 1);
  if (!/^[ts]./.test(target) || !ScheduleStore.isValidDate(date)) return null;
  return { target, date };
}

async function onDateTap(user, from, rest) {
  const p = _parseDateTap(rest);
  if (!p) return false;
  return applyDate(user, from, p.target, p.date);
}

async function onTypeDateTap(user, from, target) {
  if (!/^[ts]./.test(String(target || ''))) return false;
  await ObserveState.setState(user.id, DATE_STATE, { target });
  await WhatsAppService.sendMessage(from, t(observeLang(user), 'date_type_prompt', { example: nextSchoolDays(2)[1] }));
  return true;
}

/**
 * The typed reply while awaiting_visit_date is armed. A date (today or later)
 * saves; a date-like reply that is wrong is re-asked; anything without a digit
 * is ordinary chat — the state is dropped and the message falls through.
 * @returns {Promise<boolean>} handled?
 */
async function handleTypedDate(user, from, text, state) {
  const lang = observeLang(user);
  const reply = String(text || '').trim();
  if (!/\d/.test(reply)) {
    await ObserveState.clearState(user.id);
    return false;
  }
  if (!ScheduleStore.isValidDate(reply) || reply < today()) {
    await WhatsAppService.sendMessage(from, t(lang, 'date_invalid', { example: nextSchoolDays(2)[1] }));
    return true;
  }
  await ObserveState.clearState(user.id);
  return applyDate(user, from, state.target, reply);
}

// ── my schedule ─────────────────────────────────────────────────────────

async function sendMySchedule(user, from, page = 0) {
  const lang = observeLang(user);
  const visits = await ScheduleStore.listUpcoming(user.id);
  if (!visits.length) {
    await WhatsAppService.sendMessage(from, t(lang, 'sched_empty'));
    return true;
  }
  const { items, hasMore } = pageOf(visits, page, 0);
  const rows = items.map((v) => row(
    `observe_sched_${v.id}`,
    `${v.overdue ? '⚠️ ' : ''}${v.teacher_name || t(lang, 'bind_row_visit_fallback')}`,
    [fmtDay(v.scheduled_for), v.school_name, v.overdue ? t(lang, 'sched_overdue_tag') : null].filter(Boolean).join(' · '),
  ));
  if (hasMore) rows.push(row(`observe_schedmore_${page + 1}`, t(lang, 'menu_more'), t(lang, 'menu_more_desc')));
  await WhatsAppService.sendInteractiveMessage(from, listPayload(
    t(lang, 'sched_body'), t(lang, 'sched_button'), [{ title: t(lang, 'sched_section'), rows }],
  ));
  return true;
}

async function onScheduleMoreTap(user, from, rest) {
  if (!/^\d+$/.test(String(rest))) return false;
  return sendMySchedule(user, from, parseInt(rest, 10));
}

async function _ownVisit(user, from, scheduleId) {
  const visit = await ScheduleStore.getUpcoming(user.id, scheduleId);
  if (!visit) await WhatsAppService.sendMessage(from, t(observeLang(user), 'sched_gone'));
  return visit;
}

async function onScheduleRowTap(user, from, scheduleId) {
  const visit = await _ownVisit(user, from, scheduleId);
  if (!visit) return true;
  const lang = observeLang(user);
  await WhatsAppService.sendInteractiveButtons(from, {
    body: t(lang, 'sched_action_body', { name: visit.teacher_name || '', date: fmtDay(visit.scheduled_for) }),
    buttons: [
      { id: `observe_sstart_${visit.id}`, title: t(lang, 'btn_sched_start').slice(0, 20) },
      { id: `observe_smove_${visit.id}`, title: t(lang, 'btn_sched_move').slice(0, 20) },
      { id: `observe_scancel_${visit.id}`, title: t(lang, 'btn_sched_cancel').slice(0, 20) },
    ],
  });
  return true;
}

/** Start a scheduled visit: bind the teacher exactly as the picker does. */
async function onScheduleStartTap(user, from, scheduleId) {
  const visit = await _ownVisit(user, from, scheduleId);
  if (!visit) return true;
  const teacher = await findTeacher(user, visit.teacher_ext_id);
  // A teacher who has since left the roster still gets their visit — bound by
  // what the schedule row knows, so markDone still retires it.
  const bound = teacher || {
    user_id: null, teacher_ext_id: visit.teacher_ext_id, school_id: visit.school_id || null,
    school_ext_id: visit.school_ext_id, name: visit.teacher_name, phone: null, school_name: visit.school_name,
  };
  return armAndBrief(user, from, bound, visit.school_ext_id);
}

async function onScheduleMoveTap(user, from, scheduleId) {
  const visit = await _ownVisit(user, from, scheduleId);
  if (!visit) return true;
  return sendDatePicker(user, from, `s${visit.id}`, visit.teacher_name);
}

async function onScheduleCancelTap(user, from, scheduleId) {
  const visit = await _ownVisit(user, from, scheduleId);
  if (!visit) return true;
  const ok = await ScheduleStore.cancelById(user.id, visit.id);
  await WhatsAppService.sendMessage(from, t(observeLang(user), ok ? 'sched_cancelled' : 'sched_gone', { name: visit.teacher_name || '' }));
  return true;
}

module.exports = {
  DATE_STATE,
  sendBareCapture,
  startPicker,
  sendSchools,
  sendTeachers,
  onSchoolTap,
  onSchoolMoreTap,
  onTeacherTap,
  onTeacherMoreTap,
  onSkipTap,
  startBindPicker,
  findTeacher,
  boundTeacherOf,
  nextSchoolDays,
  sendDatePicker,
  onDateTap,
  onTypeDateTap,
  handleTypedDate,
  sendMySchedule,
  onScheduleMoreTap,
  onScheduleRowTap,
  onScheduleStartTap,
  onScheduleMoveTap,
  onScheduleCancelTap,
};
