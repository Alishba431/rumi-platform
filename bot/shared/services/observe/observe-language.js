/**
 * ONE owner for "whose language is this?".
 *
 * Language used to be decided at the point of use, from whatever user object
 * happened to be in scope — almost always `session.users`, the join on
 * coaching_sessions.user_id. That column holds the TEACHER on a bound
 * observation and the COACH on a bare capture, so the same helper returned a
 * different person's language depending on how the session was created: a
 * coach got acks in the teacher's language, and a teacher's report followed
 * the coach.
 *
 * The fix is naming the AUDIENCE at the call site and resolving from the right
 * person here, once:
 *
 *     languageFor('teacher', session)   // the observed teacher's language
 *     languageFor('coach',   session)   // the observer's language
 *
 * Rules this module keeps so callers don't have to:
 *   · it NEVER reads `session.users` — that join is the bug;
 *   · a language with no observe language pack renders in English;
 *   · it is TOTAL. Every failure path returns a renderable language — it sits
 *     on render paths that must not fail closed.
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');
const { availableLanguages } = require('./observe-strings');

const FALLBACK = 'en';

/** A language this deployment can render observe copy in, else null. */
function clampToPacks(lang) {
  if (typeof lang !== 'string' || !lang.trim()) return null;
  return availableLanguages().includes(lang.trim()) ? lang.trim() : null;
}

/** One users lookup, read-only, total. Returns a renderable language or null. */
async function _preferredLanguage(column, value) {
  if (!value) return null;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('preferred_language')
      .eq(column, value)
      .maybeSingle();
    if (error) return null;
    return clampToPacks(data && data.preferred_language);
  } catch (err) {
    // A language lookup must never take down a report render.
    logToFile('⚠️ observe-language: preference lookup failed — English', { column, error: err.message });
    return null;
  }
}

/**
 * The observed teacher, in resolution order:
 *   1. the identity the coach named for this report (`teacher_delivery`), the
 *      only identity a hand-typed teacher has;
 *   2. the session's own user_id when the observation is BOUND (on a bare
 *      capture that column is the coach, so it is deliberately skipped);
 *   3. English — never the coach's language. A teacher who never set a
 *      preference must not inherit the person standing next to them.
 */
async function _teacherLanguage(session) {
  const delivery = (session && session.analysis_data && session.analysis_data.teacher_delivery) || {};
  if (delivery.teacher_phone) {
    // The address may be a channel identity (a Matrix teacher has no phone_number).
    const { userIdForIdentity } = require('./observe-identity');
    const byAddress = await _preferredLanguage('id', await userIdForIdentity(delivery.teacher_phone));
    if (byAddress) return byAddress;
  }

  const teacherUserId = session && session.user_id;
  const bound = teacherUserId && teacherUserId !== (session && session.observer_user_id);
  if (bound) {
    const byId = await _preferredLanguage('id', teacherUserId);
    if (byId) return byId;
  }
  return FALLBACK;
}

/** The observer — always observer_user_id, on bound and bare sessions alike. */
async function _coachLanguage(session) {
  return (await _preferredLanguage('id', session && session.observer_user_id)) || FALLBACK;
}

const RESOLVERS = { teacher: _teacherLanguage, coach: _coachLanguage };

/**
 * @param {'teacher'|'coach'} audience  who is going to READ this
 * @param {object} session  a coaching_sessions row
 * @returns {Promise<string>}
 */
async function languageFor(audience, session) {
  const resolve = RESOLVERS[audience];
  // Deliberately throws: an unknown audience is a programming error, and
  // guessing one is how the original defect was written in the first place.
  if (!resolve) throw new Error(`observe-language: unknown audience "${audience}"`);
  return resolve(session || {});
}

module.exports = { languageFor, clampToPacks };
