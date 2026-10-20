'use strict';
/**
 * Where a proactive message to a teacher goes, and when they last wrote in.
 *
 * A reply goes back to the identifier the inbound message came from; a
 * scheduled nudge has no inbound message, so the address is read from the
 * database. A person can be linked to several channels at once (`user_channels`:
 * WhatsApp AND Slack AND Discord rows pointing at one `users` row), so the rule
 * is: the channel they used most recently, among the channels THIS deployment
 * runs, formatted as the identifier the messaging facade routes on — a bare
 * phone number for WhatsApp, `<prefix>:<id>` for an additive channel (see
 * messaging/channel-registry.js). With no usable channel row, `users.phone_number`.
 *
 * One wrinkle about the timestamps: inbound WhatsApp messages stamp
 * `users.last_message_at` on every message, while the WhatsApp `user_channels`
 * row's own `last_message_at` is only written when the row is created. Additive
 * channels (Slack, Discord) stamp their `user_channels` row and NOT the users
 * row. So "when did they last write on WhatsApp" is the later of the two, and
 * "when did they last write at all" is the latest across every row.
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');
const { prefixFor, driverForIdentifier } = require('../messaging/channel-registry');
const { resolveActiveChannels } = require('../../config/feature-availability');

const WHATSAPP = 'whatsapp';
const IN_CHUNK = 200;

const ms = (v) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const latest = (...values) => {
  let best = null;
  for (const v of values) {
    const t = ms(v);
    if (t !== null && (best === null || t > best.t)) best = { t, v };
  }
  return best ? new Date(best.t).toISOString() : null;
};

/**
 * The facade identifier for a channel row, or null when this deployment cannot send there.
 *
 * The row's stored `reply_identifier` — the exact identifier the teacher last wrote
 * from — wins whenever it routes back to that same channel: a channel's wire identity
 * need not be "<prefix>:<channel_user_id>" (a short alias form, a re-encoded id), and
 * a background send must deliver back to what came in, not re-derive it.
 */
function identifierFor(channel, channelUserId, activeChannels, replyIdentifier = null) {
  if (replyIdentifier && channel !== WHATSAPP && activeChannels.includes(channel)
    && driverForIdentifier(replyIdentifier) === channel) {
    return String(replyIdentifier);
  }
  if (!channelUserId) return null;
  if (channel === WHATSAPP) return String(channelUserId);
  const prefix = prefixFor(channel);
  if (!prefix || !activeChannels.includes(channel)) return null;
  return `${prefix}:${channelUserId}`;
}

/**
 * @param {string} userId
 * @param {Object} [opts]
 * @param {Object} [opts.user]  the users row, if the caller already has it
 *   (needs `phone_number` and `last_message_at`)
 * @returns {Promise<{to:string, channel:string, lastMessageAt:string|null}|null>}
 *   null when the teacher cannot be reached, or the lookup failed.
 */
async function addressForUser(userId, { user = null } = {}) {
  let person = user;
  if (!person) {
    const { data, error } = await supabase.from('users')
      .select('id, phone_number, last_message_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      logToFile('❌ nudges address: users read failed', { userId, error: error.message });
      return null;
    }
    person = data;
  }
  if (!person) return null;

  const { data: channels, error } = await supabase.from('user_channels')
    .select('channel, channel_user_id, reply_identifier, is_primary, last_message_at')
    .eq('user_id', userId);
  if (error) {
    logToFile('❌ nudges address: user_channels read failed', { userId, error: error.message });
    return null;
  }

  const active = resolveActiveChannels(process.env);
  const candidates = [];
  for (const row of channels || []) {
    const to = identifierFor(row.channel, row.channel_user_id, active, row.reply_identifier);
    if (!to) continue;
    const lastMessageAt = row.channel === WHATSAPP
      ? latest(row.last_message_at, person.last_message_at)
      : latest(row.last_message_at);
    candidates.push({ to, channel: row.channel, lastMessageAt, primary: !!row.is_primary });
  }

  if (!candidates.length) {
    if (!person.phone_number) return null;
    return { to: String(person.phone_number), channel: WHATSAPP, lastMessageAt: latest(person.last_message_at) };
  }

  candidates.sort((a, b) => (ms(b.lastMessageAt) || 0) - (ms(a.lastMessageAt) || 0)
    || Number(b.primary) - Number(a.primary));
  const { to, channel, lastMessageAt } = candidates[0];
  return { to, channel, lastMessageAt };
}

/**
 * When each teacher last wrote in on ANY channel, in one query per 200 users.
 *
 * @param {Array<{id:string, last_message_at:?string}>} users
 * @returns {Promise<Map<string,string|null>|null>} null when the lookup failed —
 *   a caller deciding "has this teacher gone quiet" must not guess.
 */
async function lastActivityFor(users) {
  const result = new Map();
  for (const u of users) result.set(u.id, latest(u.last_message_at));

  const ids = users.map((u) => u.id);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase.from('user_channels')
      .select('user_id, last_message_at')
      .in('user_id', ids.slice(i, i + IN_CHUNK));
    if (error) {
      logToFile('❌ nudges address: user_channels activity read failed', { error: error.message });
      return null;
    }
    for (const row of data || []) {
      result.set(row.user_id, latest(result.get(row.user_id), row.last_message_at));
    }
  }
  return result;
}

module.exports = { addressForUser, lastActivityFor };
