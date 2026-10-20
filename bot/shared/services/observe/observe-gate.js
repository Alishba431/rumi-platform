/**
 * /observe trigger gate.
 *
 * Pure, side-effect-free decision helper (mirrors evaluateHomeworkTrigger in
 * text-message.handler.js) so the routing logic is unit-testable without the
 * full handler harness.
 *
 * The capability is OBSERVE_ENABLED=true — channel-neutral on purpose. It used
 * to be "a published WhatsApp Flow id is set", which made /observe impossible
 * on any channel without a Meta Flow and coupled turning a feature on to one
 * vendor's form builder. With it unset every message falls through to normal
 * processing, so a deployment that never opts in is provably unchanged.
 */

// Dependency-free (see that module's header), so the gate stays cheap to load.
const overrides = require('../../config/feature-overrides');

// Matches "/observe" as a command (leading slash required, word boundary so
// "/observer" does NOT match). Handler passes the trimmed message.
const OBSERVE_TRIGGER_RX = /^\/observe\b/i;

// THE single source of truth for the coach role family. Registration may
// store a granular role (analytics and future per-role behaviour survive);
// every capability check goes through leaderRoles(). Deployments name the
// people who visit classrooms differently, so OBSERVE_LEADER_ROLES replaces
// the list. Nothing outside this file should compare a role literal.
//
// The role vocabulary is shared with the other features that read users.role:
// NULL or 'teacher' = a teacher; 'head_teacher' = the person who runs a school;
// 'coach'; 'supervisor'. 'principal' and 'school_leader' are accepted on READ
// as aliases of 'head_teacher' (rows written before the vocabulary settled) —
// never written (see writtenRole).
const DEFAULT_LEADER_ROLES = Object.freeze(['head_teacher', 'principal', 'school_leader', 'coach', 'supervisor']);
const HEAD_TEACHER_ALIASES = Object.freeze(['principal', 'school_leader']);

/** The role to WRITE for a requested one: aliases become head_teacher. */
function writtenRole(role) {
  const r = String(role || '').trim().toLowerCase();
  return HEAD_TEACHER_ALIASES.includes(r) ? 'head_teacher' : r;
}

/** Read at call time, so a changed env needs no restart and tests can flip it. */
function leaderRoles() {
  const raw = process.env.OBSERVE_LEADER_ROLES;
  if (!raw || !raw.trim()) return [...DEFAULT_LEADER_ROLES];
  return raw.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
}

/**
 * On when OBSERVE_ENABLED=true AND the operator has not paused it from the
 * console (RUMI_FEATURE_OBSERVE=off) — the switch can only ever subtract.
 */
function isObserveEnabled() {
  if (String(process.env.OBSERVE_ENABLED || '').trim().toLowerCase() !== 'true') return false;
  return overrides.isEnabled('observe');
}

/**
 * @param {object|null} user users row (carries role + preferences)
 * @returns {boolean}
 */
function isSchoolLeader(user) {
  return !!user && typeof user.role === 'string' && leaderRoles().includes(user.role.trim().toLowerCase());
}

// Leaders who also teach (a head teacher with their own class) may send their
// OWN lesson for self-coaching; a full-time coach may not, so their classroom
// recordings are always observations.
const DEFAULT_SELF_COACH_ROLES = Object.freeze(['head_teacher', ...HEAD_TEACHER_ALIASES]);

/**
 * May this user send their own lesson for self-coaching? Everyone outside the
 * coach family can (they are teachers); inside it, only OBSERVE_SELF_COACH_ROLES.
 */
function canSelfCoach(user) {
  if (!user) return false;
  if (!isSchoolLeader(user)) return true;
  const raw = process.env.OBSERVE_SELF_COACH_ROLES;
  const roles = raw && raw.trim()
    ? raw.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_SELF_COACH_ROLES;
  return roles.includes(user.role.trim().toLowerCase());
}

/**
 * @param {{messageBody: string, user: object|null}} input
 * @returns {{match:false}
 *   | {match:true, action:'deny_no_user'|'deny_role'|'onboard'|'capture'}}
 */
function evaluateObserveTrigger({ messageBody, user }) {
  if (!OBSERVE_TRIGGER_RX.test((messageBody || '').trim())) return { match: false };
  if (!isObserveEnabled()) return { match: false };
  if (!user) return { match: true, action: 'deny_no_user' };
  if (!isSchoolLeader(user)) return { match: true, action: 'deny_role' };

  const prefs = user.preferences || {};
  if (!prefs.observe_onboarded) return { match: true, action: 'onboard' };
  return { match: true, action: 'capture' };
}

/**
 * Framework pin: a leader observation's analysis ALWAYS uses the observe pack —
 * the coach's edit form is shaped by the pack, so the framework must never
 * depend on the OBSERVER's own settings or phone prefix (a draft the form can't
 * prefill is the failure this prevents). A teacher's own recording keeps
 * whatever selectFramework picks for them.
 *
 * @param {object} session coaching_sessions row
 * @param {{selectFramework: Function}} deps
 */
async function pickObservationFramework(session, { selectFramework }) {
  if (session && session.observation_type === 'leader_observation') {
    // eslint-disable-next-line global-require -- lazy: keeps the gate dependency-free for the text handler
    const { getObservePack } = require('./observe-framework');
    return getObservePack().module;
  }
  return selectFramework(session.user_id);
}

module.exports = {
  OBSERVE_TRIGGER_RX,
  DEFAULT_LEADER_ROLES,
  leaderRoles,
  writtenRole,
  isObserveEnabled,
  evaluateObserveTrigger,
  isSchoolLeader,
  canSelfCoach,
  pickObservationFramework,
};
