/**
 * The coach's roster — DERIVED, never stored twice.
 *
 * A coach holds schools (leader_schools). Their teachers are whoever has
 * users.school_id in one of those schools. An earlier design also stored one
 * row per (coach, school, teacher); the stored list and the schools drifted
 * apart, because two copies of one fact always do. A join cannot disagree
 * with itself, so this is the only model shipped here.
 *
 * Teachers are identified by users.id (teacher_ext_id below is the same id,
 * kept under that name because schedules and visit records key on it).
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');
const { isSchoolLeader } = require('./observe-gate');
const { identitiesForUsers } = require('./observe-identity');

/** @returns {Promise<Array<{id, ext_id, name}>>} the coach's schools, by name */
async function listSchools(leaderUserId) {
  if (!leaderUserId) return [];
  const { data, error } = await supabase
    .from('leader_schools')
    .select('school_id, school_ext_id, school_name')
    .eq('leader_user_id', leaderUserId);
  if (error) {
    logToFile('⚠️ observe-roster: school list failed', { leaderUserId, error: error.message });
    return [];
  }
  return (data || [])
    .filter((r) => r.school_id)
    .map((r) => ({ id: r.school_id, ext_id: r.school_ext_id || null, name: r.school_name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * @param {string} leaderUserId
 * @param {{schoolId?: string}} [opts] scope to one of the coach's schools
 * @returns {Promise<Array<{user_id, teacher_ext_id, name, phone, school_id, school_ext_id, school_name, preferred_language}>>}
 */
async function listTeachers(leaderUserId, { schoolId } = {}) {
  const schools = await listSchools(leaderUserId);
  const scoped = schoolId ? schools.filter((s) => s.id === schoolId) : schools;
  if (!scoped.length) return [];
  const bySchool = new Map(scoped.map((s) => [s.id, s]));

  const { data, error } = await supabase
    .from('users')
    .select('id, name, first_name, phone_number, school_id, role, preferred_language')
    .in('school_id', [...bySchool.keys()]);
  if (error) {
    logToFile('⚠️ observe-roster: teacher list failed', { leaderUserId, error: error.message });
    return [];
  }
  const teachers = (data || [])
    // Another coach attached to the same school is a colleague, not a teacher to observe.
    .filter((u) => u.id !== leaderUserId && !isSchoolLeader(u));
  // `phone` is the teacher's channel identity: their phone number on WhatsApp,
  // their channel address otherwise (a Matrix teacher has no phone_number).
  const identities = await identitiesForUsers(teachers.map((u) => u.id));
  return teachers
    .map((u) => {
      const school = bySchool.get(u.school_id);
      return {
        user_id: u.id,
        teacher_ext_id: u.id,
        name: u.name || u.first_name || 'Teacher',
        phone: identities.get(u.id) || null,
        school_id: u.school_id,
        school_ext_id: school.ext_id,
        school_name: school.name,
        preferred_language: u.preferred_language || null,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Does this coach hold at least one school? Any error → false (bare capture still works). */
async function hasAssignment(leaderUserId) {
  try {
    return (await listSchools(leaderUserId)).length > 0;
  } catch (_) {
    return false;
  }
}

/** The schedule key for a teacher's school: its register id, else its own id. */
function schoolKeyOf(teacher) {
  return (teacher && (teacher.school_ext_id || teacher.school_id)) || null;
}

/**
 * The boundTeacher shape capture reads from observe state, from a roster
 * teacher. schoolExtId overrides the key (a scheduled visit's own key, so
 * markDone retires exactly that row).
 */
function boundTeacherOf(teacher, schoolExtId = null) {
  return {
    user_id: teacher.user_id || null,
    teacher_ext_id: teacher.teacher_ext_id,
    school_ext_id: schoolExtId || schoolKeyOf(teacher),
    school_id: teacher.school_id || null,
    name: teacher.name || null,
    phone: teacher.phone || null,
  };
}

module.exports = { listSchools, listTeachers, hasAssignment, schoolKeyOf, boundTeacherOf };
