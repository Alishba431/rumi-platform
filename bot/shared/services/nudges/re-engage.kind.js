'use strict';
/**
 * Nudge kind `re_engage` — a friendly check-in for a teacher who went quiet.
 *
 * COHORT (prepare). Registered teachers whose last message, on any channel, is
 * older than TEACHER_NUDGES_QUIET_MINUTES (default 1200 = 20 h) and newer than
 * TEACHER_NUDGES_LOOKBACK_DAYS (default 14) — so a teacher who left months ago
 * is not messaged out of the blue. One row per teacher per local day (the
 * table's UNIQUE), booked due immediately.
 *
 * ONCE PER QUIET SPELL. Every row records the `last_message_at` it is about.
 * A teacher is not booked again while a `sent` row (or a `window_closed` skip)
 * exists for that same value — i.e. until they write in again, nobody nudges
 * them a second time, however many days the silence lasts. Writing in starts a
 * new spell, and the next silence can be nudged.
 *
 * SEND (handle). Re-checks everything at send time, because a row can sit for a
 * tick: still registered, still quiet (else `active_again`), not quiet hours
 * (`quiet_hours`), reachable (`no_address`). On the Meta WhatsApp Cloud driver a
 * free-form message is only allowed inside the 24-hour customer-service window,
 * so outside it the row is skipped `window_closed` — this kind sends no
 * template. Baileys, Slack and Discord have no such window.
 *
 * QUIET HOURS. prepare books nothing during quiet hours; a row that is reached
 * during quiet hours anyway (booked at 20:59, claimed at 21:01) is skipped, not
 * deferred. The teacher stays in the cohort and is booked again on a later
 * local day if they are still quiet, so a skip at night costs a day, not the
 * spell. (Deferring the row instead would let the next day's booking and the
 * deferred row both send in one tick.)
 *
 * A reply needs no special routing: it is a normal free-text message and goes
 * to the normal chat.
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');
const WhatsAppService = require('../whatsapp.service');
const { driverForIdentifier } = require('../messaging/channel-registry');
const { resolveChannelDriver } = require('../../config/feature-availability');
const store = require('./teacher-nudges.store');
const { addressForUser, lastActivityFor } = require('./address');
const { localDate, isQuietHour } = require('./local-time');

const KIND = 're_engage';
const DEFAULT_QUIET_MINUTES = 1200;
const DEFAULT_LOOKBACK_DAYS = 14;
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE = 1000;
const MAX_COHORT = 10000;
const IN_CHUNK = 200;

const positive = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** How long a teacher must have been silent, in minutes. */
function quietMinutes() {
  return positive(process.env.TEACHER_NUDGES_QUIET_MINUTES, DEFAULT_QUIET_MINUTES);
}

/** How far back a silence may have started and still be nudged, in days. */
function lookbackDays() {
  return positive(process.env.TEACHER_NUDGES_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS);
}

const ms = (v) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const sameInstant = (a, b) => ms(a) !== null && ms(a) === ms(b);

/** The message. Short, warm, and a reply goes straight to the normal chat. */
function messageFor(user) {
  const first = String((user && user.first_name) || '').trim().split(/\s+/)[0];
  const hi = first ? `Hi ${first} 👋` : 'Hi 👋';
  return `${hi} — it has been a little while. Planning anything for your next class? `
    + 'Tell me the topic and I can draft a lesson plan, or ask me anything about your teaching.';
}

/** Does this identifier go out through the Meta WhatsApp Cloud driver? */
function isMetaRoute(to) {
  return driverForIdentifier(to) === null && resolveChannelDriver(process.env) === 'meta';
}

/** Registered users whose users.last_message_at OR a channel row falls in the window. */
async function candidates(quietCutoff, lookbackCutoff) {
  const byId = new Map();

  for (let from = 0; from < MAX_COHORT; from += PAGE) {
    const { data, error } = await supabase.from('users')
      .select('id, last_message_at')
      .eq('registration_completed', true)
      .lt('last_message_at', quietCutoff)
      .gt('last_message_at', lookbackCutoff)
      .order('last_message_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`users cohort read failed — ${error.message}`);
    for (const u of data || []) byId.set(u.id, u);
    if (!data || data.length < PAGE) break;
  }

  // Additive channels (Slack, Discord) stamp user_channels, not the users row,
  // so a teacher who went quiet there may not show up above.
  const { data: channelRows, error: channelError } = await supabase.from('user_channels')
    .select('user_id')
    .lt('last_message_at', quietCutoff)
    .gt('last_message_at', lookbackCutoff)
    .limit(MAX_COHORT);
  if (channelError) throw new Error(`user_channels cohort read failed — ${channelError.message}`);

  const extra = [...new Set((channelRows || []).map((r) => r.user_id))].filter((id) => !byId.has(id));
  for (let i = 0; i < extra.length; i += IN_CHUNK) {
    const { data, error } = await supabase.from('users')
      .select('id, last_message_at')
      .eq('registration_completed', true)
      .in('id', extra.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`users read for channel cohort failed — ${error.message}`);
    for (const u of data || []) byId.set(u.id, u);
  }

  return [...byId.values()];
}

/**
 * Book today's rows for the cohort. Idempotent and cheap to repeat: it runs on
 * every tick, on every replica.
 *
 * @returns {Promise<number>} rows this call created.
 */
async function prepare(now = new Date()) {
  if (isQuietHour(now)) return 0;

  const at = now.getTime();
  const quietCutoff = new Date(at - quietMinutes() * 60 * 1000).toISOString();
  const lookbackCutoff = new Date(at - lookbackDays() * 24 * 60 * 60 * 1000).toISOString();
  const today = localDate(now);

  const users = await candidates(quietCutoff, lookbackCutoff);
  if (!users.length) return 0;

  const activity = await lastActivityFor(users);
  if (!activity) throw new Error('activity lookup failed; booking nothing rather than guessing');

  const quiet = users.filter((u) => {
    const t = ms(activity.get(u.id));
    return t !== null && t < ms(quietCutoff) && t > ms(lookbackCutoff);
  });
  if (!quiet.length) return 0;

  // Every existing row of this kind for the cohort, in one read per chunk.
  const existing = new Map();
  const ids = quiet.map((u) => u.id);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await store.rowsForUsers(ids.slice(i, i + IN_CHUNK), {
      kind: KIND,
      sinceDate: localDate(new Date(lookbackCutoff)),
    });
    if (rows === null) throw new Error('could not read earlier nudges; booking nothing rather than risk a repeat');
    for (const r of rows) {
      if (!existing.has(r.user_id)) existing.set(r.user_id, []);
      existing.get(r.user_id).push(r);
    }
  }

  let booked = 0;
  for (const user of quiet) {
    const lastMessageAt = new Date(ms(activity.get(user.id))).toISOString();
    const rows = existing.get(user.id) || [];

    const blocked = rows.some((r) => r.nudge_date === today
      || r.status === store.STATUS.PENDING
      || r.status === store.STATUS.SENDING
      || ((r.status === store.STATUS.SENT
        || (r.status === store.STATUS.SKIPPED && r.skip_reason === 'window_closed'))
        && sameInstant(r.context && r.context.last_message_at, lastMessageAt)));
    if (blocked) continue;

    try {
      const { created } = await store.book({
        userId: user.id,
        kind: KIND,
        nudgeDate: today,
        scheduledAt: now,
        context: { last_message_at: lastMessageAt },
      });
      if (created) booked += 1;
    } catch (error) {
      logToFile('❌ re_engage: could not book a row', { userId: user.id, error: error.message });
    }
  }
  return booked;
}

/** One claimed row. The sweeper records whatever this returns, or a throw as failed. */
async function handle(row, { now = new Date() } = {}) {
  const { data: user, error } = await supabase.from('users')
    .select('id, first_name, phone_number, registration_completed, last_message_at')
    .eq('id', row.user_id)
    .maybeSingle();
  if (error) throw new Error(`users read failed — ${error.message}`);
  if (!user || user.registration_completed !== true) return { skipped: 'not_eligible' };

  const activity = await lastActivityFor([user]);
  if (!activity) throw new Error('activity lookup failed');
  const lastActivity = activity.get(user.id);
  const booked = row.context && row.context.last_message_at;
  if (!sameInstant(lastActivity, booked)
    || now.getTime() - ms(lastActivity) < quietMinutes() * 60 * 1000) {
    return { skipped: 'active_again' };
  }

  if (isQuietHour(now)) return { skipped: 'quiet_hours' };

  const address = await addressForUser(user.id, { user });
  if (!address) return { skipped: 'no_address' };

  if (isMetaRoute(address.to)) {
    const last = ms(address.lastMessageAt);
    if (last === null || now.getTime() - last >= SERVICE_WINDOW_MS) {
      return { skipped: 'window_closed', context: { channel: address.channel } };
    }
  }

  const ok = await WhatsAppService.sendMessage(address.to, messageFor(user));
  if (!ok) throw new Error('sendMessage returned false');
  return { sent: true, context: { channel: address.channel } };
}

module.exports = {
  kind: KIND,
  KIND,
  DEFAULT_QUIET_MINUTES,
  DEFAULT_LOOKBACK_DAYS,
  quietMinutes,
  lookbackDays,
  messageFor,
  prepare,
  handle,
};
