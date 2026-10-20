/**
 * One owner for "this observation is over."
 *
 * A cancelled observation can be revived by any button sent before the
 * cancel, by the analysis job that was already queued, or by a sweep — each
 * resolves the session from an id and would write without reading `status`.
 * The statuses live here, with the PostgREST filter spelled once so a write
 * predicate and an in-process check can never drift apart.
 */

/** Statuses past which an observation must not be advanced or re-entered. */
const TERMINAL_STATUSES = ['cancelled', 'abandoned'];

/** The same set as a PostgREST `.not('status', 'in', …)` argument. */
const TERMINAL_IN_FILTER = `(${TERMINAL_STATUSES.join(',')})`;

/**
 * @param {string|null|undefined} status a coaching_sessions.status
 * @returns {boolean} true when the session is over and nothing may advance it
 */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(String(status || ''));
}

module.exports = { TERMINAL_STATUSES, TERMINAL_IN_FILTER, isTerminalStatus };
