'use strict';
/**
 * The teacher-nudge sweeper — the periodic half of scheduled teacher nudges.
 *
 * WHAT IT DOES, in order, once per tick: reclaim whatever is stuck in
 * `sending`, then for each REGISTERED kind — build that kind's cohort
 * (`prepare`), claim what is due, hand each claimed row to that kind's
 * `handle`, record the outcome — and finally write one summary log line.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: send anything itself. A kind that nobody in
 * this process registered is never claimed, so the sweep cannot take a row that
 * nothing here knows how to deliver.
 *
 * A kind is a plain module:
 *
 *   { kind: 're_engage',                         // lower_snake_case, unique
 *     prepare: async (now) => <rows booked>,      // optional; books cohort rows
 *     handle:  async (row, { now }) =>           // required; one claimed row
 *       ({ sent: true, context }) | ({ skipped: '<SKIP_REASON>', context }) }
 *
 * `handle` may throw; a throw (or any other answer) marks the row failed.
 * Handlers never write their own row — the sweeper records every outcome, so
 * the funnel counts cannot drift between kinds.
 *
 * The clauses:
 *   single-flight  rows arrive only from `store.claimDue`, a conditional UPDATE
 *                  returning what IT won. Two replicas ticking in the same
 *                  second each hold a disjoint set.
 *   kill switch    TEACHER_NUDGES_ENABLED (and the operator's feature switch),
 *                  read at CALL time. Off and the tick touches nothing at all —
 *                  not even a read.
 *   per-tick cap   TEACHER_NUDGES_MAX_PER_TICK (default 200) claimed rows per
 *                  tick, across every kind. A backlog drips out over ticks.
 *   one log line   exactly one summary line per tick with all its counts, so an
 *                  idle sweeper and a broken one do not look identical.
 *
 * NOTHING HERE THROWS. A sweeper that can throw takes the worker's interval with
 * it; every failure is caught, logged, counted, and the tick carries on.
 */

const store = require('./teacher-nudges.store');
const { flagOn } = require('./flags');
const { logToFile } = require('../../utils/logger');
const overrides = require('../../config/feature-overrides');

const DEFAULT_MAX_PER_TICK = 200;
const KIND_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** kind → kind module. Insertion order is sweep order. */
const registry = new Map();

const FEATURE_ID = 'teacher_nudges';

/**
 * The master switch, read at call time and never cached. Exported because the
 * worker gates arming its interval on the same answer.
 *
 * On means TEACHER_NUDGES_ENABLED is on AND the operator has not paused the
 * feature with its switch (RUMI_FEATURE_TEACHER_NUDGES=off, see
 * config/feature-overrides.js). The switch is read from the in-process cache
 * (the console updates it live) and from the environment, because a worker
 * process never loads the cache itself.
 */
function isEnabled() {
  if (!flagOn('TEACHER_NUDGES_ENABLED')) return false;
  if (!overrides.isEnabled(FEATURE_ID)) return false;
  const paused = String(process.env[overrides.envVarFor(FEATURE_ID)] || '').trim().toLowerCase() === 'off';
  return !paused;
}

/** The per-tick claim budget: TEACHER_NUDGES_MAX_PER_TICK, a positive integer, else 200. */
function maxPerTick() {
  const n = Number(process.env.TEACHER_NUDGES_MAX_PER_TICK);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PER_TICK;
}

function logError(message, data) {
  logToFile(`❌ teacher_nudges sweep: ${message}`, data);
}

/**
 * Register a kind for this process. Registering the same module object again is
 * a no-op (the worker and a script may both load it); a DIFFERENT module for a
 * kind that is already registered throws — two owners for one kind means two
 * messages for one teacher.
 */
function register(kindModule) {
  const { kind, prepare, handle } = kindModule || {};
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    throw new Error(`teacher_nudges sweeper: kind must be lower_snake_case, got ${JSON.stringify(kind)}`);
  }
  if (typeof handle !== 'function') {
    throw new Error(`teacher_nudges sweeper: ${kind} must export a handle(row, { now }) function`);
  }
  if (prepare !== undefined && typeof prepare !== 'function') {
    throw new Error(`teacher_nudges sweeper: prepare for ${kind} must be a function`);
  }
  if (registry.has(kind)) {
    if (registry.get(kind) === kindModule) return;
    throw new Error(
      `teacher_nudges sweeper: ${kind} is already registered — two owners for one kind `
      + 'means two messages for one teacher',
    );
  }
  registry.set(kind, kindModule);
}

/** The kinds this process will sweep, in sweep order. */
function registeredKinds() {
  return [...registry.keys()];
}

/** One claimed row, start to finish. Returns which counter to bump. */
async function handleRow(kindModule, row, now) {
  const { kind } = kindModule;
  try {
    const outcome = await kindModule.handle(row, { now });

    if (outcome && outcome.sent === true) {
      const marked = await store.markSent(row.id, { context: outcome.context || {} });
      if (!marked) {
        // The teacher HAS the message; only the row failed to flip. Said here so
        // a later stale reclaim of a delivered nudge is not a mystery.
        logError('sent but the row could not be marked sent', { kind, id: row.id });
      }
      return 'sent';
    }

    if (outcome && typeof outcome.skipped === 'string') {
      await store.markSkipped(row.id, outcome.skipped, outcome.context || {});
      return 'skipped';
    }

    throw new Error(`handle for ${kind} returned ${JSON.stringify(outcome)} — expected {sent:true} or {skipped:reason}`);
  } catch (error) {
    logError('row failed', { kind, id: row.id, error: error.message });
    try {
      await store.markFailed(row.id, error);
    } catch (markError) {
      logError('could not mark the row failed', { kind, id: row.id, error: markError.message });
    }
    return 'failed';
  }
}

/**
 * One tick.
 *
 * @param {Object} [opts]
 * @param {Date}   [opts.now]    the tick's clock, handed to every prepare/handle
 * @param {number} [opts.limit]  claim budget for this tick (default: maxPerTick())
 * @returns {Promise<{booked, claimed, sent, skipped, failed, reclaimed, off?: true}>}
 */
async function runSweep({ now = new Date(), limit } = {}) {
  const counts = { booked: 0, claimed: 0, sent: 0, skipped: 0, failed: 0, reclaimed: 0 };

  if (!isEnabled()) return { off: true, ...counts };

  const budget = Number.isInteger(limit) && limit > 0 ? limit : maxPerTick();

  try {
    counts.reclaimed = await store.reclaimStale({ now });
  } catch (error) {
    logError('reclaimStale failed', { error: error.message });
  }

  for (const kindModule of registry.values()) {
    const { kind } = kindModule;

    if (kindModule.prepare) {
      try {
        const booked = await kindModule.prepare(now);
        if (Number.isInteger(booked) && booked > 0) counts.booked += booked;
      } catch (error) {
        // The cohort may be short, but rows booked on an earlier tick are still
        // due — skipping the claim as well would strand them.
        logError('prepare failed; claiming anyway', { kind, error: error.message });
      }
    }

    const remaining = budget - counts.claimed;
    if (remaining <= 0) continue;

    let rows = [];
    try {
      rows = await store.claimDue({ kind, limit: remaining, now });
    } catch (error) {
      logError('claim failed', { kind, error: error.message });
      continue;
    }

    counts.claimed += rows.length;
    for (const row of rows) {
      counts[await handleRow(kindModule, row, now)] += 1;
    }
  }

  logToFile('teacher_nudges sweep: done', { ...counts, kinds: registeredKinds() });
  return counts;
}

module.exports = {
  DEFAULT_MAX_PER_TICK,
  register,
  registeredKinds,
  runSweep,
  isEnabled,
  maxPerTick,
};
