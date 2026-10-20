'use strict';
/**
 * ONE ATTEMPT PER CHILD.
 *
 * A child who re-opens the class link is started again — beginFromCode
 * recognises the handset and startForStudent makes a new quiz_sessions row;
 * nothing blocks it. Read raw, every such row is another child in "finished",
 * in the average, in the hardest-question tallies and on the class card. In
 * practice this is common, not an edge case: over one week of live use, about
 * a thousand (quiz, child) pairs carried more than one completed attempt, and
 * one child had forty.
 *
 * The attempt that counts is the FIRST COMPLETED one. Every answer's feedback
 * shows the right option and re-joining is never blocked, so a retake after
 * reading the reasons is not the child's standing — counting the latest would
 * let any child score full marks on a second go. With nothing completed it is
 * the latest row (so a child mid-quiz still shows as started).
 * Rows without a student_id cannot be grouped and pass through untouched.
 * Pure, so it can be asserted directly.
 *
 * Every reader that counts children goes through this one function — the class
 * report and card (video-quiz-report), /quiz's list counts
 * (transcript-quiz-list countsFor) and the "only N have started" nudge — so
 * the teacher reads one number for one class, wherever it is shown. A reader must select student_id,
 * status, completed_at and created_at for the rule to see the attempts: a row
 * without student_id is counted as its own child.
 */
function oneAttemptPerChild(sessions) {
  const done = (s) => s.status === 'completed';
  // ISO timestamps compare as strings. A completed row without a completed_at
  // sorts by when it was started.
  const finishedAt = (s) => String(s.completed_at || s.created_at || '');
  const better = (a, b) => {
    if (done(a) !== done(b)) return done(a);
    // Two completed: the earlier finish counts. Neither: the later start shows.
    if (done(a)) return finishedAt(a) < finishedAt(b);
    return String(a.created_at || '') > String(b.created_at || '');
  };
  const byChild = new Map();
  const loose = [];
  (sessions || []).forEach((s) => {
    if (!s) return;
    if (!s.student_id) { loose.push(s); return; }
    const cur = byChild.get(s.student_id);
    if (!cur || better(s, cur)) byChild.set(s.student_id, s);
  });
  return [...byChild.values(), ...loose];
}

module.exports = { oneAttemptPerChild };
