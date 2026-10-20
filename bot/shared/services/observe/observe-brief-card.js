'use strict';
/**
 * The visit brief — what a coach reads before walking into a classroom.
 *
 * Plain chat text, so it renders the same on every channel. It carries the
 * last observation's focus for this teacher (what the coach and teacher agreed
 * to work on) and what to look for this time. Invariants:
 *  - NEVER a score, a percentage or a rank: the brief is guidance, not a grade
 *    (the footer says so, always);
 *  - no history → an honest first-visit line, never an invented strength;
 *  - one focus, one thing to look for — the coach is going to help, not audit.
 */

const { t } = require('./observe-strings');
const { logToFile } = require('../../utils/logger');

// Only an observation the coach has looked at (or at least a finished draft)
// has a focus worth carrying forward.
const FOCUS_STATUSES = ['observer_review_complete', 'awaiting_observer_review', 'analysis_complete'];

const clean = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/**
 * The focus of this teacher's most recent observation, or null.
 * @returns {Promise<{focus: string, look: string|null, strength: string|null}|null>}
 */
async function loadLastFocus(teacherUserId) {
  if (!teacherUserId) return null;
  try {
    const supabase = require('../../config/supabase');
    const { data, error } = await supabase
      .from('coaching_sessions')
      .select('id, status, created_at, analysis_data')
      .eq('user_id', teacherUserId)
      .eq('observation_type', 'leader_observation')
      .in('status', FOCUS_STATUSES)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const a = row.analysis_data || {};
      const focus = a.focus_area || {};
      const title = clean(focus.title);
      if (!title) continue;
      const strength = Array.isArray(a.strengths) && a.strengths[0] ? clean(a.strengths[0].title) : null;
      return { focus: title, look: clean(focus.try), strength };
    }
    return null;
  } catch (err) {
    logToFile('⚠️ observe-brief: last-focus lookup failed (brief degrades to first-visit)', { teacherUserId, error: err.message });
    return null;
  }
}

/**
 * @param {string} lang
 * @param {{name, school_name}} teacher
 * @param {object|null} last  loadLastFocus() result
 * @returns {string}
 */
function buildBriefText(lang, teacher, last) {
  const name = clean(teacher && teacher.name) || 'the teacher';
  const lines = [t(lang, 'brief_title', { name })];
  if (teacher && clean(teacher.school_name)) lines.push(t(lang, 'brief_school', { school: teacher.school_name }));
  lines.push('');
  if (last) {
    if (last.strength) lines.push(t(lang, 'brief_last_strength', { strength: last.strength }));
    lines.push(t(lang, 'brief_last_focus', { focus: last.focus }));
    lines.push(last.look ? t(lang, 'brief_last_try', { try: last.look }) : t(lang, 'brief_look_for_default'));
  } else {
    lines.push(t(lang, 'brief_first_visit', { name }));
    lines.push(t(lang, 'brief_look_for_default'));
  }
  lines.push('', t(lang, 'brief_footer'));
  return lines.join('\n');
}

/** Load + build, never throws (an empty history is still a brief). */
async function briefFor(lang, teacher) {
  const last = await loadLastFocus(teacher && teacher.user_id);
  return buildBriefText(lang, teacher, last);
}

module.exports = { loadLastFocus, buildBriefText, briefFor };
