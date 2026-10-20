/**
 * Teacher Nudges Worker — one sweep, for a cron scheduler
 *
 * The same sweep bot/workers/sqs-worker.js runs on an in-process interval when
 * TEACHER_NUDGES_ENABLED is on, packaged as a one-shot for a deployment that
 * would rather schedule it (Railway Cron, crontab, a Kubernetes CronJob):
 *
 *   every 5 minutes:  node bot/workers/teacher-nudges.worker.js
 *
 * Running both is harmless — the sweep's claim is single-flight, so two
 * schedulers can never send one row twice — but one is enough.
 *
 * With TEACHER_NUDGES_ENABLED off this does nothing and exits 0.
 * See docs/features/teacher-nudges.md.
 */

require('dotenv').config();
const { logToFile } = require('../shared/utils/logger');
const sweeper = require('../shared/services/nudges/teacher-nudges.sweeper');
const { registerAllKinds } = require('../shared/services/nudges/kinds');

/**
 * Run one sweep. Returns its counts (or `{ off: true }`); never calls
 * process.exit itself, so it can be invoked from a script or a test.
 */
async function main({ now = new Date() } = {}) {
  if (!sweeper.isEnabled()) {
    console.log('Teacher nudges are off (TEACHER_NUDGES_ENABLED) — nothing to do');
    return { off: true };
  }
  const kinds = registerAllKinds(sweeper);
  const counts = await sweeper.runSweep({ now });
  console.log('📊 Teacher-nudge sweep:', { kinds, ...counts });
  return counts;
}

// Gated — requiring this file as a library (e.g. from a test) does NOT sweep.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('❌ Teacher-nudge worker error:', error);
      logToFile('❌ Teacher-nudge worker error', { error: error.message, stack: error.stack });
      process.exit(1);
    });
}

module.exports = { main };
