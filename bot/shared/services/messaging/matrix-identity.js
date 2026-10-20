/**
 * matrix-identity.js -- shared short/long identity FORMAT codec for the
 * Matrix channel, and the homeserver allowlist it depends on. Pure string
 * logic only (no storage/network).
 *
 * ## Why this exists -- the varchar(20) budget (bug: lesson plan creation
 * failing with "value too long for type character varying(20)")
 *
 * bot/shared/services/lesson-plan-queue.service.js:36 (and several other
 * shared tables -- chat_starts.phone_number, video_quiz_deliveries.phone,
 * failed_operations.user_id, users.phone_number) write the channel-routing
 * identity straight into a `character varying(20)` column sized for a plain
 * phone number. Confirmed against the real local Postgres on 2026-09-22 via:
 *
 *   select table_name, column_name, character_maximum_length
 *   from information_schema.columns
 *   where data_type = 'character varying' and character_maximum_length <= 32
 *     and (column_name ilike '%phone%' or column_name ilike '%user%'
 *          or column_name ilike '%identif%' or column_name ilike '%id');
 *
 * The tightest hits were all varchar(20) (lesson_plan_requests, users,
 * failed_operations, video_quiz_deliveries, dashboard_users). The product
 * owner does not want that schema changed, and does not want other channels
 * touched -- so the fix has to be an identity Matrix itself never emits too
 * long, for the case that actually matters: a teacher whose Matrix username
 * IS their phone number (the product's own stated onboarding path).
 *
 * ## Matrix username shape (revised twice, 2026-09-22 -- see git history)
 *
 * A PURELY numeric Matrix localpart is impossible -- Synapse rejects it, both
 * on public registration and via `register_new_matrix_user` as admin
 * ("M_INVALID_USERNAME: Numeric user IDs are reserved for guest users"),
 * verified live. Synapse DOES accept a leading "+", also verified live
 * (`register_new_matrix_user -u "+15550100001"` succeeded, login works, full
 * id "@+15550100001:localhost") -- and "+<number>" is how a phone number is
 * already written everywhere else in the product (WhatsApp's own shape), so
 * that is the CANONICAL teacher-username convention. A leading "t" (e.g.
 * "t15550100001") is kept as a FALLBACK form -- accounts were already
 * created that way before "+" was confirmed to work, and some other
 * homeserver might reject "+" -- so both are treated as "a phone-number
 * username": a localpart that is either "+" or "t", then 7-15 digits,
 * nothing else (7 is a generous floor for a short-but-real national number;
 * 15 is E.164's hard ceiling).
 *
 * ## Budget arithmetic
 *
 * The tightest column is varchar(20). The LOCALPART itself can be up to 16
 * characters ("+"/"t" + 15 digits), so naively reusing it in a prefixed
 * identity is already too long: "matrix:" (7) + "@" (1) + 16-char localpart +
 * ":x" (2) is comfortably over 20 before a real domain is even added --
 * "matrix:" is out on its own ("matrix:" + up to 16 = 23).
 *
 * The leading "+" is only a Synapse registration-syntax requirement, not
 * part of the phone number Rumi actually needs downstream -- so the short
 * wire identity drops it and carries the bare DIGITS, exactly the shape Rumi
 * already expects from WhatsApp:
 *
 *   20 (tightest column)  -  15 (max E.164 digits)  =  5 characters spare
 *                                                       for a prefix+separator
 *   chosen prefix "mtx:"  =  4 characters  ->  4 + 15 = 19 chars, 1 to spare
 *
 * The one spare character is what the "t" form spends: "mtx:t" + 15 digits
 * = 20, exactly the budget (see "One account per identity" below).
 *
 * ("mx:" (3 chars, 3+15=18) would leave 2 spare instead of 1 -- also fits,
 * and was suggested as an alternative -- but "mtx:" was kept: it was already
 * wired into channel-registry.js's ALIAS_PREFIXES/driverForIdentifier before
 * this revision, is still comfortably inside the 20-char budget, and reads
 * less like a typo of "mx"/a currency code in a log line.) "mtx:" was picked
 * over the more obvious "matrix:" specifically because "matrix:" alone is 7
 * characters -- 7 + 15 = 22, already over budget by itself even for bare
 * digits, let alone a "+"/"t"-prefixed localpart. It doesn't collide with the
 * "slack"/"discord" prefixes channel-registry.js already reserves in
 * CHANNEL_PREFIXES (see that file's ALIAS_PREFIXES for how it's wired into
 * driverForIdentifier without disturbing prefixFor('matrix'), which stays
 * 'matrix' -- existing tests depend on that).
 *
 * ## One account per identity, and only on our own homeserver
 *
 * An identity IS a Rumi teacher: their users row, sessions, classes, and (for
 * the short form) the phone number the portal signs them in by. So it must
 * name exactly one Matrix account, and the short form drops the one part of
 * a user id that makes it unique across homeservers. It is therefore used
 * ONLY for the bot's own server (MATRIX_USER_ID, or the whoami result):
 *
 *   "@+15550100001:<own>"  ->  "mtx:15550100001"   (the canonical account)
 *   "@t15550100001:<own>"  ->  "mtx:t15550100001"  (a DIFFERENT account)
 *   "@+15550100001:<other>" -> "matrix:@+15550100001:<other>"
 *
 * Both short forms decode back to exactly the account they came from, so no
 * memory of "which form did this number use" is needed. An earlier version
 * mapped both forms on any server to "mtx:<digits>" and remembered the last
 * form seen: anyone who could register "@+<a teacher's number>" on another
 * homeserver (federation is on by default in Synapse), or the "t" twin on a
 * server with open registration, became that teacher. If the own server is
 * not known yet, the long form is used -- never a short form that could
 * belong to some other server. Which servers may reach Rumi at all is
 * allowedServers() below (MATRIX_ALLOWED_SERVERS, default: our own).
 *
 * Non-phone-shaped localparts (admin accounts, our own test users like
 * "@teacher:localhost" or "@teacher576594:localhost" -- itself alphanumeric,
 * not "+"/"t"+digits-only) are NOT shortened: there is no reversible short
 * form for an arbitrary string that fits the budget, so they keep the
 * existing long "matrix:@user:server" form, which may still overflow the
 * varchar(20) columns on some flows. That is a known, LOUD (logged once at
 * info level), not-silently-swallowed limitation -- teachers should register
 * with their phone number. Truncating instead would be worse: two different
 * long identities that happen to share their first N characters would
 * silently collide, routing a reply to the wrong person.
 */

const SHORT_PREFIX = 'mtx';
const LONG_PREFIX = 'matrix';
// Either "+" (canonical, matches WhatsApp's own phone-number shape) or "t"
// (fallback -- see this file's header comment) followed by 7-15 digits. Only
// lowercase "t": Matrix localparts are lowercase, and "T" could not decode
// back to the same account.
const PHONE_LOCALPART_RE = /^(\+|t)(\d{7,15})$/;
// The part of a short identity after "mtx:": bare digits ("+" account) or
// "t" + digits ("t" account).
const SHORT_BODY_RE = /^(t?)(\d{7,15})$/;

// Module-level -- deliberately fires the "may exceed the limit" warning only
// ONCE per process, not once per message, so a chatty non-phone-username
// deployment doesn't spam the log.
let warnedNonPhoneOnce = false;

/** Test-only: lets a fresh test re-trigger the one-time warning. */
function _resetWarnedForTests() {
  warnedNonPhoneOnce = false;
}

/** Splits a full "@<localpart>:<server>" Matrix user id, or returns null if it isn't shaped like one. The server keeps any port ("localhost:8448"). */
function splitUserId(fullUserId) {
  const raw = String(fullUserId || '');
  if (!raw.startsWith('@')) return null;
  const colonIdx = raw.indexOf(':');
  if (colonIdx <= 1 || colonIdx === raw.length - 1) return null; // no colon, empty localpart ("@:server") or empty server
  return { localpart: raw.slice(1, colonIdx), server: raw.slice(colonIdx + 1) };
}

/** The bot's own server name, from its full user id, or null if unknown. */
function ownServerOf(ownUserId) {
  return splitUserId(ownUserId)?.server || null;
}

/**
 * The homeservers whose users may reach Rumi: the bot's own server, plus any
 * listed in MATRIX_ALLOWED_SERVERS (comma-separated server names, compared
 * exactly as they appear in user ids, port included). The own server is
 * always in: it is where the bot's account and the admin-created teacher
 * accounts live. Empty when the own server is unknown and nothing is listed.
 *
 * @param {string|null} ownUserId the bot's own full Matrix user id
 * @param {object} [env] defaults to process.env
 * @returns {Set<string>}
 */
function allowedServers(ownUserId, env = process.env) {
  const servers = new Set(
    String(env.MATRIX_ALLOWED_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  const own = ownServerOf(ownUserId);
  if (own) servers.add(own);
  return servers;
}

/** Whether a full Matrix user id belongs to an allowed homeserver (see allowedServers()). */
function isAllowedSender(fullUserId, ownUserId, env = process.env) {
  const parsed = splitUserId(fullUserId);
  return Boolean(parsed && allowedServers(ownUserId, env).has(parsed.server));
}

/**
 * Encodes a full Matrix user id into the shortest safe wire identity. On the
 * bot's own server, a phone-number-shaped localpart becomes "mtx:<digits>"
 * ("+" form, the "+" dropped) or "mtx:t<digits>" ("t" form). Everything else
 * -- any other username, any user on another server, or any user at all
 * while the own server is unknown -- keeps the long "matrix:@<localpart>:<server>"
 * form. See this file's header comment ("One account per identity").
 *
 * @param {string} fullUserId e.g. "@+15550100001:localhost", "@t15550100001:localhost", or "@teacher:localhost"
 * @param {string|null} ownUserId the bot's own full Matrix user id (e.g. "@rumi:localhost")
 * @param {{ logToFile?: Function }} [deps] structured logger, injected so this
 *   pure-ish module has no hard dependency on the logger's location
 * @returns {string}
 */
function encodeIdentity(fullUserId, ownUserId, deps = {}) {
  const raw = String(fullUserId || '');
  const parsed = splitUserId(raw);
  const own = ownServerOf(ownUserId);
  const match = parsed && own && parsed.server === own ? PHONE_LOCALPART_RE.exec(parsed.localpart) : null;

  if (match) {
    return `${SHORT_PREFIX}:${match[1] === 't' ? 't' : ''}${match[2]}`;
  }

  if (!warnedNonPhoneOnce) {
    warnedNonPhoneOnce = true;
    const log = deps.logToFile || (() => {});
    log(
      'ℹ️ Matrix: non-phone-number Matrix username in use -- the long "matrix:@user:server" identity this produces '
      + 'may exceed the 20-character column limit on some flows (lesson plan requests, chat starts, etc), '
      + 'causing those specific writes to fail. Teachers should register with their phone number '
      + '(e.g. +15550100001) as their Matrix username to stay inside the short-identity form.',
      { channel: 'matrix', userId: raw }
    );
  }
  return `${LONG_PREFIX}:${raw}`;
}

/**
 * Decodes a wire identity (long OR short form) back into the full Matrix
 * user id it was encoded from. A short form always names an account on the
 * bot's own server: "mtx:<digits>" is "@+<digits>:<own>", "mtx:t<digits>" is
 * "@t<digits>:<own>".
 *
 * @param {string} identity e.g. "mtx:15550100001", "mtx:t15550100001", "matrix:@teacher:localhost", or an already-bare "@user:server"
 * @param {string|null} ownUserId the bot's own full Matrix user id (e.g. "@rumi:localhost") -- only needed to decode the short form
 * @returns {string} full "@localpart:server" Matrix user id
 * @throws {Error} if given a short-form identity but ownUserId's server name
 *   is unknown, or a short-form identity that is not one of the two phone forms
 */
function decodeIdentity(identity, ownUserId) {
  const raw = String(identity || '');

  if (raw.startsWith(`${SHORT_PREFIX}:`)) {
    const match = SHORT_BODY_RE.exec(raw.slice(SHORT_PREFIX.length + 1));
    if (!match) {
      throw new Error(`matrix-identity: "${raw}" is not a short Matrix identity ("mtx:<digits>" or "mtx:t<digits>")`);
    }
    const server = ownServerOf(ownUserId);
    if (!server) {
      throw new Error(
        'matrix-identity: cannot decode short identity "' + raw + '" -- the bot\'s own server name is unknown '
        + '(MATRIX_USER_ID is not set and the connection has not resolved its own user id yet)'
      );
    }
    return `@${match[1] || '+'}${match[2]}:${server}`;
  }

  if (raw.startsWith(`${LONG_PREFIX}:`)) {
    return raw.slice(LONG_PREFIX.length + 1);
  }

  return raw; // already a bare "@user:server" (or unrecognized) -- pass through unchanged, matching prior behavior
}

module.exports = {
  SHORT_PREFIX,
  LONG_PREFIX,
  PHONE_LOCALPART_RE,
  splitUserId,
  ownServerOf,
  allowedServers,
  isAllowedSender,
  encodeIdentity,
  decodeIdentity,
  _resetWarnedForTests,
};
