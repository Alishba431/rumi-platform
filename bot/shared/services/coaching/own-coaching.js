/**
 * A teacher's OWN coaching sessions — never a coach's observation of them.
 *
 * Observe files a coach's observation under the observed teacher
 * (coaching_sessions.user_id) with observation_type set, and its score is the
 * coach's rating. So every read of "this teacher's sessions" — their trend,
 * prior feedback, chat context, /status, counts — goes through ownCoaching(),
 * which adds `observation_type IS NULL`.
 *
 * The column arrives with the observe migration. A bot deployed before that
 * migration must keep computing a teacher's coaching exactly as before:
 * PostgREST would answer "column does not exist", and these readers degrade
 * quietly, so the teacher would get an empty trend and "no prior sessions"
 * with Observe never switched on. The column is therefore probed once per
 * process (probe(), called at start-up): without it the filter is skipped —
 * such a database holds no observations to skip — and the missing migration
 * is logged as an error. Until the probe answers, the filter is applied.
 */

const { logToFile } = require('../../utils/logger');

const MIGRATION = 'infrastructure/supabase/migrations/V2.6.0__observe_coach_assistant.sql';

let hasColumn = true;
let probing = null;

function isMissingColumn(error) {
  return !!error && (error.code === '42703' || /observation_type/.test(String(error.message || '')));
}

/** Once per process: does coaching_sessions have observation_type? Never throws. */
function probe() {
  if (!probing) {
    probing = (async () => {
      try {
        // Lazy: config/supabase exits without env, and most callers are loaded before it matters.
        const supabase = require('../../config/supabase');
        const { error } = await supabase.from('coaching_sessions').select('observation_type').limit(1);
        if (isMissingColumn(error)) {
          hasColumn = false;
          logToFile(`❌ coaching_sessions.observation_type is missing — apply the observe migration (${MIGRATION}). `
            + 'Teachers\' own coaching is read without the observation filter until then.', { error: error.message });
        }
      } catch (err) {
        // Unknown (no database yet, a network blip): keep the filter, the safe side for the firewall.
        logToFile('⚠️ own-coaching: column probe failed — keeping the observation filter', { error: err.message });
      }
      return hasColumn;
    })();
  }
  return probing;
}

/**
 * Narrow a coaching_sessions query to the teacher's own sessions. Synchronous,
 * so it wraps the query where the filter belongs in the chain.
 */
function ownCoaching(query) {
  return hasColumn ? query.is('observation_type', null) : query;
}

/** Tests only. */
function _reset() {
  hasColumn = true;
  probing = null;
}

module.exports = { ownCoaching, probe, isMissingColumn, _reset };
