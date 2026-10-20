'use strict';
/**
 * The teacher-nudge store — every read and write of `teacher_nudges`.
 *
 * One table, one module. Nothing else in the bot touches `teacher_nudges`
 * directly, so the two guards that make scheduled messaging safe live in one
 * place and cannot be half-applied by a caller in a hurry:
 *
 *   G1 · BOOKING IS IDEMPOTENT. `book` INSERTs and reads 23505 as "somebody
 *        already booked this", returning the row that won. The UNIQUE
 *        (user_id, nudge_date, kind) is doing the work — several worker
 *        replicas building the same cohort produce one row and the rest no-ops.
 *        Checking for an existing row first and then inserting would be a race,
 *        not a guard.
 *
 *   G2 · SENDING IS CLAIMED. supabase-js cannot express `UPDATE … LIMIT n`, so
 *        `claimDue` selects candidate ids and then flips them pending → sending
 *        with `.eq('status','pending')` STILL ON THE UPDATE, and treats only the
 *        rows the update returned as claimed. Two sweepers that selected the same
 *        ids each get exactly the rows their own UPDATE won; the loser gets an
 *        empty array and sends nothing. Drop that one `.eq` and this becomes a
 *        check-then-act that double-sends under two replicas.
 *
 * Every chain checks `error` and every failure is logged. A read that fails
 * returns the empty answer rather than throwing — a sweeper tick that cannot
 * reach the database must skip, not crash the worker — while `book` throws,
 * because a caller building a cohort needs to know its insert did not happen.
 *
 * `kind` is free text on purpose: the set of kinds is the sweeper's code
 * registry, not a database CHECK, so adding a kind needs no migration.
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');

const TABLE = 'teacher_nudges';

/** The five states the table's CHECK constraint allows. */
const STATUS = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  SKIPPED: 'skipped',
  FAILED: 'failed',
});

/**
 * Why a teacher was deliberately NOT nudged. Closed on purpose and validated in
 * `markSkipped`: this token is the only record of which rule fired, so a typo'd
 * reason is a hole in the funnel nobody notices. A skip is the product working;
 * a failure is a defect. A new kind that needs a new reason adds it here.
 */
const SKIP_REASONS = Object.freeze([
  'window_closed',   // Meta's 24-hour customer-service window has closed
  'quiet_hours',     // local night-time; see local-time.js
  'active_again',    // the teacher spoke after the row was booked
  'no_address',      // no channel this deployment can reach them on
  'not_eligible',    // the user row is gone or no longer qualifies
  'disabled',        // the kind was switched off between booking and sending
]);

/** How long a row may sit in `sending` before it is called a failure. */
const STALE_MINUTES = 10;

/** The most rows one call claims when the caller does not say. */
const DEFAULT_CLAIM_LIMIT = 200;

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function logDbError(what, error, extra = {}) {
  logToFile(`❌ teacher_nudges: ${what}`, {
    error: error && error.message ? error.message : String(error),
    code: error && error.code,
    ...extra,
  });
}

/**
 * Leave `sending`: write `patch`, merge `contextPatch` into the row's context
 * and count the attempt.
 *
 * The read is deliberate: `context` is a jsonb sidecar several writers add to
 * (the cohort builder records what the nudge is about, the sweeper records a
 * skip reason or an error). A bare `.update({ context: { error } })` REPLACES
 * the object and throws away the record of what the teacher was nudged about.
 * The same read gives the attempt count, so every exit from `sending` bumps
 * `attempts` once — it equals the number of times the row was claimed.
 *
 * @param {Array} [guard]  `[column, value]` the UPDATE must still match.
 * @returns {Promise<boolean>} true when a row was written.
 */
async function finishRow(id, patch, contextPatch = {}, guard = null) {
  const { data: current, error: readError } = await supabase.from(TABLE)
    .select('context, attempts')
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    logDbError('could not read row before update', readError, { id });
    return false;
  }
  if (!current) return false;

  let q = supabase.from(TABLE).update({
    ...patch,
    context: { ...(current.context || {}), ...contextPatch },
    attempts: (Number(current.attempts) || 0) + 1,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (guard) q = q.eq(guard[0], guard[1]);

  const { data: updated, error } = await q.select();
  if (error) {
    logDbError('update failed', error, { id, status: patch.status });
    return false;
  }
  return (updated || []).length > 0;
}

/** The one row for (teacher, kind, local day) — or null. */
async function rowFor(userId, kind, nudgeDate) {
  const { data, error } = await supabase.from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('kind', kind)
    .eq('nudge_date', nudgeDate)
    .maybeSingle();
  if (error) {
    logDbError('rowFor failed', error, { kind, nudgeDate });
    return null;
  }
  return data || null;
}

/**
 * Book one nudge. Idempotent by the UNIQUE (G1).
 *
 * @returns {Promise<{row:Object|null, created:boolean}>} `created:false` means
 *   the row was already there and `row` is THAT row — the caller's context was
 *   not written, which is correct: the first booking of the day wins.
 */
async function book({ userId, kind, nudgeDate, scheduledAt, context = {} }) {
  const row = {
    user_id: userId,
    kind,
    nudge_date: nudgeDate,
    scheduled_at: iso(scheduledAt),
    status: STATUS.PENDING,
    context,
    attempts: 0,
  };

  const { data, error } = await supabase.from(TABLE).insert(row).select().single();
  if (!error) return { row: data, created: true };

  if (error.code === '23505') {
    return { row: await rowFor(userId, kind, nudgeDate), created: false };
  }

  logDbError('book insert failed', error, { kind, nudgeDate });
  throw new Error(`teacher_nudges: could not book ${kind} — ${error.message}`);
}

/**
 * Claim the due, pending rows of one kind (G2).
 *
 * @returns {Promise<Array<Object>>} ONLY the rows this call won. An empty array
 *   is a normal outcome — nothing due, or another replica got there first.
 */
async function claimDue({ kind, limit = DEFAULT_CLAIM_LIMIT, now = new Date() } = {}) {
  if (!(limit > 0)) return [];

  const { data: candidates, error: selectError } = await supabase.from(TABLE)
    .select('id')
    .eq('kind', kind)
    .eq('status', STATUS.PENDING)
    .lte('scheduled_at', iso(now))
    .order('scheduled_at', { ascending: true })
    .limit(limit);

  if (selectError) {
    logDbError('claim select failed', selectError, { kind });
    return [];
  }

  const ids = (candidates || []).map((r) => r.id);
  if (!ids.length) return [];

  const { data: claimed, error: updateError } = await supabase.from(TABLE)
    .update({ status: STATUS.SENDING, claimed_at: iso(now), updated_at: new Date().toISOString() })
    .in('id', ids)
    .eq('status', STATUS.PENDING)   // ← the claim. Never remove this.
    .select();

  if (updateError) {
    logDbError('claim update failed', updateError, { kind, candidates: ids.length });
    return [];
  }

  return claimed || [];
}

/** The teacher has it. */
async function markSent(id, { context = {} } = {}) {
  return finishRow(id, { status: STATUS.SENT, sent_at: new Date().toISOString() }, context);
}

/**
 * Deliberately not sent. Throws on a reason outside `SKIP_REASONS`, BEFORE any
 * database call — an unknown reason is a bug in the caller, and writing it would
 * put an unqueryable value in the one column that explains the funnel.
 */
async function markSkipped(id, reason, context = {}) {
  if (!SKIP_REASONS.includes(reason)) {
    throw new Error(
      `teacher_nudges: unknown skip reason ${JSON.stringify(reason)} — `
      + `add it to SKIP_REASONS or use one of: ${SKIP_REASONS.join(', ')}`,
    );
  }
  return finishRow(id, { status: STATUS.SKIPPED, skip_reason: reason }, context);
}

/** The send failed or threw. The MESSAGE is stored, not the object — jsonb cannot hold a stack. */
async function markFailed(id, error) {
  const message = error && error.message ? error.message : String(error || 'unknown');
  return finishRow(id, { status: STATUS.FAILED }, { error: message });
}

/**
 * Not now: hand a claimed row back to `pending`, due at `scheduledAt`. Guarded
 * on `status = 'sending'` — only the claim holder can hand a row back, and a row
 * that finished in between is not revived.
 */
async function release(id, { scheduledAt, context = {} } = {}) {
  return finishRow(
    id,
    { status: STATUS.PENDING, scheduled_at: iso(scheduledAt || new Date()), claimed_at: null },
    context,
    ['status', STATUS.SENDING],
  );
}

/**
 * Rows claimed by a tick that then died mid-send sit in `sending` for ever,
 * invisible to the next claim (it only takes `pending`). After the ceiling they
 * are called what they are — failures — so the counts stay honest. They are not
 * put back to `pending`: the message may have gone out before the process died,
 * and a second copy is worse than a missing one.
 *
 * Each write keeps `status = 'sending'` as a guard so a row that finished
 * between the select and the update is not clobbered.
 *
 * @returns {Promise<number>} how many rows were actually flipped.
 */
async function reclaimStale({ now = new Date(), olderThanMinutes = STALE_MINUTES, limit = DEFAULT_CLAIM_LIMIT } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const cutoff = new Date(at.getTime() - olderThanMinutes * 60 * 1000).toISOString();

  const { data: stale, error } = await supabase.from(TABLE)
    .select('id')
    .eq('status', STATUS.SENDING)
    .lt('claimed_at', cutoff)
    .order('claimed_at', { ascending: true })
    .limit(limit);

  if (error) {
    logDbError('reclaimStale select failed', error, { olderThanMinutes });
    return 0;
  }

  let reclaimed = 0;
  for (const row of stale || []) {
    const ok = await finishRow(row.id, { status: STATUS.FAILED }, { error: 'stale_sending' }, ['status', STATUS.SENDING]);
    if (ok) reclaimed += 1;
  }
  return reclaimed;
}

/** A teacher's nudges, newest day first. */
async function rowsFor(userId, { kind = null, status = null, limit = 50 } = {}) {
  let q = supabase.from(TABLE).select('*').eq('user_id', userId);
  if (kind) q = q.eq('kind', kind);
  if (status) q = q.eq('status', status);

  const { data, error } = await q.order('nudge_date', { ascending: false }).limit(limit);
  if (error) {
    logDbError('rowsFor failed', error, { kind });
    return [];
  }
  return data || [];
}

/**
 * Every row of one kind for a set of teachers since a date — one query for a
 * whole cohort, so a cohort builder never reads per teacher.
 */
async function rowsForUsers(userIds, { kind, sinceDate = null } = {}) {
  if (!userIds || !userIds.length) return [];
  let q = supabase.from(TABLE)
    .select('id, user_id, nudge_date, status, skip_reason, context')
    .eq('kind', kind)
    .in('user_id', userIds);
  if (sinceDate) q = q.gte('nudge_date', sinceDate);

  const { data, error } = await q;
  if (error) {
    logDbError('rowsForUsers failed', error, { kind, users: userIds.length });
    return null;
  }
  return data || [];
}

module.exports = {
  TABLE,
  STATUS,
  SKIP_REASONS,
  STALE_MINUTES,
  DEFAULT_CLAIM_LIMIT,
  book,
  claimDue,
  markSent,
  markSkipped,
  markFailed,
  release,
  reclaimStale,
  rowsFor,
  rowsForUsers,
  rowFor,
};
