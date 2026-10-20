/**
 * Matrix connection manager -- the ONE place that owns the persistent Matrix
 * sync connection. Mirrors discord-connection.js's role exactly (a single
 * shared client, exposed via getClient()): matrix-channel.service.js (the
 * outbound driver) and matrix-events.adapter.js (the inbound listener) both
 * share this ONE client instance -- a second `new MatrixClient()` against the
 * same access token would run a second, redundant /sync loop against the
 * homeserver, which is wasteful and (with E2EE on) actively harmful: two
 * processes racing the same Olm/Megolm session state corrupts the crypto
 * store, not just double-delivers messages.
 *
 * `matrix-bot-sdk` is loaded LAZILY, inside connect(), matching this repo's
 * existing lazy-client convention (see discord-connection.js's own header
 * comment, and shared/storage/r2.js's lazyClient) -- requiring this file never
 * touches the real `matrix-bot-sdk` package or opens a sync connection; only
 * connect()/getClient() do.
 *
 * E2EE (MATRIX_E2EE, default "on" = required; only "off" starts without it):
 * matrix-bot-sdk only makes encryption functional when a crypto storage
 * provider is passed to the MatrixClient constructor (its own doc comment:
 * "If not supplied, end-to-end encryption will not be functional in this
 * client."). That provider (RustSdkCryptoStorageProvider) needs a
 * `StoreType` enum value -- and that enum is exported by the separate native
 * package `@matrix-org/matrix-sdk-crypto-nodejs` itself
 * (`require('@matrix-org/matrix-sdk-crypto-nodejs').StoreType`), NOT by
 * `matrix-bot-sdk` -- matrix-bot-sdk@0.8.0's own exports are `CryptoClient`,
 * `requiresCrypto`, `RustSdkCryptoStorageProvider`,
 * `RustSdkAppserviceCryptoStorageProvider` and nothing named `StoreType` at
 * all (confirmed against the installed package; an earlier version of this
 * file imported it from the wrong package, which threw
 * "Cannot read properties of undefined (reading 'Sqlite')" on every host and
 * was then swallowed by an over-broad catch as a misleading "missing native
 * binary" message -- exactly backwards, since that was a code bug, not an
 * environment fact).
 *
 * The enum is read from matrix-bot-sdk's OWN copy of that package (its nested
 * hard dependency, 0.4.0, Node 22+, the copy that actually encrypts), never a
 * top-level one -- see matrix-crypto-module.js. That package ships prebuilt
 * binaries per platform/Node ABI with no source fallback, so it IS a genuine
 * "can be absent on this host" dependency (no matching prebuild, a failed
 * binary download), just not the only failure mode. buildCryptoProvider()
 * therefore distinguishes the two:
 *   - MODULE_NOT_FOUND (the package or its binary is genuinely absent) →
 *     logged as a warning, a real environment fact.
 *   - anything else (wrong API usage, a corrupted store, ...) → logged at
 *     ERROR level with the real message/code/stack, because that is a BUG,
 *     not an environment limitation, and must never look like the quiet
 *     "expected" case above.
 * In BOTH cases startup FAILS (throws) instead of downgrading: encryption
 * fails closed. An earlier "auto" default started in plaintext with only a
 * log line, which on any host without crypto meant every teacher's messages
 * crossed the homeserver unencrypted without anyone deciding that. Only an
 * explicit `MATRIX_E2EE=off` starts without encryption (and skips the
 * attempt entirely); "auto" and any other value now mean "on".
 *
 * Sends never assume a room is unencrypted (guardEncryptedSends): with E2EE
 * on, matrix-bot-sdk's MatrixClient#sendEvent encrypts only when its
 * RoomTracker says the room is encrypted, and RoomTracker reads a room's
 * m.room.encryption state the first time the bot sends there -- swallowing a
 * FAILED read as "no encryption" (matrix-bot-sdk/lib/e2ee/RoomTracker.js:
 * `catch (e) { return; // failure == no encryption }`). A 502 or a timeout on
 * that one request sent the message, or the attachment's bytes, into an
 * encrypted room in plaintext. roomIsEncrypted() asks the homeserver itself
 * whenever the SDK says "not encrypted": M_NOT_FOUND is the only answer that
 * allows plaintext; any other failure refuses the send.
 *
 * `events` is the one place to observe connection lifecycle, mirroring
 * discord-connection.js's/baileys-connection.js's own `events` emitter.
 *
 * Serialized/retried account data (crash fix, 2026-09-22): matrix-bot-sdk's
 * own `client.dms` (constructed inside its MatrixClient constructor --
 * matrix-bot-sdk/lib/MatrixClient.js -- not something this file opts into)
 * attaches an internal `room.invite` listener
 * (`this.client.on("room.invite", (rid, ev) => this.handleInvite(rid, ev))`,
 * matrix-bot-sdk/lib/DMs.js) with NO try/catch of its own around
 * `await this.persistCache()`, which does a bare
 * `await this.client.setAccountData('m.direct', obj)`. A burst of pending
 * invites (AutojoinRoomsMixin joins them all in parallel) fires that
 * listener once per invite, i.e. N concurrent PUTs to the SAME account-data
 * row -- Postgres aborts the losing transactions with a
 * SerializationFailure, Synapse turns that into a 500, and the rejection
 * from `setAccountData` has nothing in matrix-bot-sdk (or in our own code)
 * catching it: it comes straight out of an EventEmitter listener callback,
 * i.e. an unhandled rejection that killed the whole Node process (reproduced
 * live -- see the PR/commit this comment shipped with).
 *
 * Our own welcome-DM "greeted" marker (org.rumi.messenger.greeted, see
 * matrix-events.adapter.js#markGreeted) writes account data the same way and
 * is exposed to the identical contention during a join burst.
 *
 * wrapSetAccountDataSerialized() is the seam: it replaces the live client's
 * OWN `setAccountData` with a version that (1) serializes every call -- ours
 * and the SDK's internal ones alike -- through one plain promise chain (no
 * new dependency), so no two writes to the account-data store are ever
 * in-flight at once, and (2) retries a failing write a few times with a
 * short backoff, since a SerializationFailure is transient by construction
 * (Postgres aborts one of two racing transactions; a retry against the now-
 * quiescent row succeeds). Patching the client's own method -- rather than
 * adding a global `process.on('unhandledRejection', ...)` -- means only
 * Matrix account-data writes are affected; an unrelated bug elsewhere in the
 * bot still crashes loudly, as it should. After retries are exhausted the
 * wrapped function LOGS and SWALLOWS the error instead of rejecting --
 * account data here is inherently best-effort and self-healing on the next
 * call (see DMs.fixDms/hasBeenGreeted, which never trust a stale entry
 * blindly) -- and, critically, a promise it hands back to the SDK's
 * `persistCache()`/our own `markGreeted()` must never reject, because both
 * callers have no catch of their own around that await.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { logToFile } = require('../../utils/logger');
const matrixIdentity = require('./matrix-identity');

let client = null;
let clientPromise = null;
let cachedUserId = null;
let cryptoEnabled = false;
// Rooms confirmed encrypted. Only "encrypted" is remembered: a room's
// encryption can never be turned off again, but an unencrypted room can be
// switched on at any time, and a failed lookup proves nothing.
const encryptedRooms = new Set();
const events = new EventEmitter();
const connectionState = { connected: false };

// Set by close() so a sync-loop error firing during intentional shutdown is
// not mistaken for a real problem worth logging loudly -- mirrors
// baileys-connection.js's/discord-connection.js's own `shuttingDown` flag.
let shuttingDown = false;

/**
 * "off" only when MATRIX_E2EE is exactly "off"; "on" otherwise (unset, "on",
 * the retired "auto", or a typo) -- a typo must never be what turns
 * encryption off. Exported so `rumi doctor` reads the same rule.
 */
function e2eeMode() {
  return (process.env.MATRIX_E2EE || '').trim().toLowerCase() === 'off' ? 'off' : 'on';
}

function storageDir() {
  return process.env.MATRIX_STORAGE_DIR || './.matrix-storage';
}

/**
 * Builds the crypto storage provider for E2EE, or null when E2EE is off or
 * (in "auto" mode only) the crypto module couldn't be loaded on this host.
 * Throws when MATRIX_E2EE=on was set explicitly and the provider could not
 * be built for ANY reason -- see file header for the full policy.
 */
function buildCryptoProvider(dir) {
  const mode = e2eeMode();
  if (mode === 'off') {
    logToFile('ℹ️ Matrix: MATRIX_E2EE=off -- starting without end-to-end encryption', {});
    return null;
  }

  try {
    // eslint-disable-next-line global-require -- lazy, optional native module (see file header)
    const { RustSdkCryptoStorageProvider } = require('matrix-bot-sdk');
    // StoreType lives on the crypto package itself, NOT on matrix-bot-sdk --
    // and on the SDK's own copy of it, not a top-level one (see file header).
    // eslint-disable-next-line global-require -- lazy: only touched when E2EE is actually requested
    const { StoreType } = require('./matrix-crypto-module').loadSdkCryptoModule();
    const provider = new RustSdkCryptoStorageProvider(path.join(dir, 'crypto'), StoreType.Sqlite);
    cryptoEnabled = true;
    return provider;
  } catch (error) {
    cryptoEnabled = false;
    const moduleAbsent = error.code === 'MODULE_NOT_FOUND';

    if (moduleAbsent) {
      // A genuine environment fact, not a bug -- warn level.
      logToFile(
        '⚠️ Matrix: E2EE crypto module (matrix-bot-sdk\'s @matrix-org/matrix-sdk-crypto-nodejs) is not installed on this host -- '
        + 'it needs a prebuilt native binary matching this platform and Node version.',
        { error: error.message, code: error.code }
      );
    } else {
      // NOT a missing-module condition -- a real bug (wrong API usage, a
      // corrupted crypto store, ...). Always logged loudly, at error level,
      // with the full message/code/stack, regardless of MATRIX_E2EE mode --
      // this must never be mistaken for the quiet "expected" case above.
      logToFile(
        '❌ Matrix: E2EE crypto provider failed to initialize for a reason OTHER than the module being '
        + 'absent -- this is a bug, not an environment limitation.',
        { error: error.message, code: error.code, stack: error.stack, level: 'error' }
      );
    }

    throw new Error(
      'Matrix: end-to-end encryption is required, but the crypto provider could not be built '
      + `(${error.code || 'no error code'}: ${error.message}) -- refusing to start without encryption. `
      + (moduleAbsent
        ? 'matrix-bot-sdk\'s @matrix-org/matrix-sdk-crypto-nodejs (Node 22 or newer) or its native binary is missing: '
          + 'reinstall bot dependencies (npm ci in bot/) on this host. '
        : '')
      + 'Set MATRIX_E2EE=off only if plaintext is acceptable on this homeserver.'
    );
  }
}

const ACCOUNT_DATA_RETRY_ATTEMPTS = 4;
const ACCOUNT_DATA_RETRY_BASE_MS = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replaces `matrixClient.setAccountData` in place with a serialized,
 * retried, never-rejecting version. See the file header comment
 * ("Serialized/retried account data") for the full why -- this is what
 * stops a burst of invites (matrix-bot-sdk's own internal `DMs` class) and
 * our own welcome-DM "greeted" marker from racing concurrent writes to the
 * same account-data row and crashing the process.
 *
 * @param {import('matrix-bot-sdk').MatrixClient} matrixClient
 */
function wrapSetAccountDataSerialized(matrixClient) {
  const original = matrixClient.setAccountData.bind(matrixClient);
  let queue = Promise.resolve();

  async function attemptWithRetry(type, content) {
    for (let attempt = 1; attempt <= ACCOUNT_DATA_RETRY_ATTEMPTS; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential retries
        return await original(type, content);
      } catch (error) {
        const isLastAttempt = attempt === ACCOUNT_DATA_RETRY_ATTEMPTS;
        if (isLastAttempt) {
          logToFile(
            '❌ Matrix: account-data write failed after retries -- swallowed (best-effort, self-heals on next write)',
            { channel: 'matrix', accountDataType: type, attempts: attempt, error: error.message }
          );
          return undefined; // never reject -- see wrapSetAccountDataSerialized's header comment
        }
        logToFile('⚠️ Matrix: account-data write failed, retrying', {
          channel: 'matrix', accountDataType: type, attempt, error: error.message,
        });
        // eslint-disable-next-line no-await-in-loop -- short backoff between retries, by design
        await sleep(ACCOUNT_DATA_RETRY_BASE_MS * attempt);
      }
    }
    return undefined;
  }

  matrixClient.setAccountData = function serializedSetAccountData(type, content) {
    const run = () => attemptWithRetry(type, content);
    // Chain onto the queue regardless of how the PREVIOUS write settled --
    // attemptWithRetry() never rejects, but the extra .catch(() => {}) means
    // the queue itself can never wedge even if that guarantee is ever broken
    // by a future edit.
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };
}

// Inviters already logged as declined, so a server that keeps inviting the
// bot costs one log line per inviter, not one per invite. Bounded.
const DECLINED_LOG_MAX = 1000;
const declinedInviters = new Set();

const ENCRYPTION_LOOKUP_TIMEOUT_MS = 15000;

/** Rejects if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Whether `roomId` is end-to-end encrypted, as far as a SEND must care:
 * resolves true (encrypted, and the SDK knows it), false (genuinely not
 * encrypted, or E2EE is off on this connection), or REJECTS when that can't be
 * established -- the caller must then not send. See the file header ("Sends
 * never assume a room is unencrypted").
 *
 * @param {import('matrix-bot-sdk').MatrixClient} matrixClient
 * @param {string} roomId
 * @returns {Promise<boolean>}
 */
async function roomIsEncrypted(matrixClient, roomId) {
  if (!matrixClient.crypto) return false;
  if (encryptedRooms.has(roomId)) return true;

  const refuse = (reason, detail = {}) => {
    logToFile('❌ Matrix: cannot confirm whether the room is encrypted -- refusing to send rather than risk plaintext', {
      channel: 'matrix', roomId, reason, ...detail, level: 'error',
    });
    return new Error(`Matrix: refusing to send to ${roomId}: its encryption state is unknown (${reason})`);
  };

  // The SDK's own answer first: a room already in its crypto store costs no
  // round trip. Its "false" is not trusted -- that is the swallowed failure.
  if (await matrixClient.crypto.isRoomEncrypted(roomId)) {
    encryptedRooms.add(roomId);
    return true;
  }

  let encryption;
  try {
    encryption = await withTimeout(
      matrixClient.getRoomStateEvent(roomId, 'm.room.encryption', ''),
      ENCRYPTION_LOOKUP_TIMEOUT_MS,
      'the m.room.encryption lookup'
    );
  } catch (error) {
    if (error && error.errcode === 'M_NOT_FOUND') return false; // genuinely no encryption state
    throw refuse('the m.room.encryption lookup failed', {
      error: error?.message, statusCode: error?.statusCode, errcode: error?.errcode,
    });
  }
  if (!encryption || typeof encryption !== 'object') throw refuse('the homeserver returned no m.room.encryption content');

  // The room IS encrypted and the SDK has not recorded it. Record it in the
  // SDK's own crypto store, exactly as RoomTracker#queueRoomCheck would have
  // (the state content, algorithm defaulted the same way), so sendEvent
  // encrypts -- then ask the SDK again rather than trusting the write.
  try {
    await matrixClient.cryptoStore.storeRoom(roomId, { ...encryption, algorithm: encryption.algorithm ?? 'UNKNOWN' });
  } catch (error) {
    throw refuse('could not record the room as encrypted in the crypto store', { error: error.message });
  }
  if (!(await matrixClient.crypto.isRoomEncrypted(roomId))) {
    throw refuse('the room is encrypted but matrix-bot-sdk still reports it as not encrypted');
  }
  encryptedRooms.add(roomId);
  return true;
}

/**
 * Wraps the live client's own `sendEvent` -- the one method every Matrix
 * event send goes through (sendMessage, and the SDK's sendText/sendNotice/
 * reply* helpers, all call it) -- so it first runs roomIsEncrypted(), which
 * rejects instead of letting the SDK fall back to plaintext. Patched on the
 * client, like wrapSetAccountDataSerialized(), so no call site can miss it.
 *
 * @param {import('matrix-bot-sdk').MatrixClient} matrixClient
 */
function guardEncryptedSends(matrixClient) {
  const original = matrixClient.sendEvent.bind(matrixClient);
  matrixClient.sendEvent = async function guardedSendEvent(roomId, eventType, content) {
    await roomIsEncrypted(matrixClient, roomId);
    return original(roomId, eventType, content);
  };
}

/**
 * Auto-accepts room invites from an allowed homeserver -- the bot's own, plus
 * MATRIX_ALLOWED_SERVERS (matrix-identity.js#allowedServers) -- like
 * matrix-bot-sdk's own AutojoinRoomsMixin.setupOnClient(), except a failed
 * join is caught and logged instead of being left to reject out of an
 * EventEmitter callback (see connect()'s call site for that crash). An
 * invite from any other server is declined (leaveRoom rejects an invite):
 * with federation on, anyone anywhere could otherwise open a room with Rumi.
 * If the own server cannot be worked out, nothing is joined (the invite stays
 * pending) -- never a guess.
 *
 * @param {import('matrix-bot-sdk').MatrixClient} matrixClient
 */
function autojoinRoomInvites(matrixClient) {
  matrixClient.on('room.invite', async (roomId, event) => {
    const inviter = event?.sender;
    try {
      const ownUserId = process.env.MATRIX_USER_ID || cachedUserId || await matrixClient.getUserId();
      if (!matrixIdentity.isAllowedSender(inviter, ownUserId)) {
        if (!declinedInviters.has(inviter)) {
          if (declinedInviters.size >= DECLINED_LOG_MAX) declinedInviters.clear();
          declinedInviters.add(inviter);
          logToFile('🚫 Matrix: declined an invite from a homeserver that is not allowed (see MATRIX_ALLOWED_SERVERS)', {
            channel: 'matrix', roomId, inviter,
          });
        }
        matrixClient.leaveRoom(roomId).catch((error) => {
          logToFile('⚠️ Matrix: failed to decline an invite -- not joined', { channel: 'matrix', roomId, error: error.message });
        });
        return;
      }
    } catch (error) {
      logToFile('⚠️ Matrix: could not check an invite -- not joined, invite left pending', {
        channel: 'matrix', roomId, inviter, error: error.message,
      });
      return;
    }
    matrixClient.joinRoom(roomId).catch((error) => {
      logToFile('⚠️ Matrix: failed to auto-join an invited room -- skipped, invite left pending', {
        channel: 'matrix', roomId, error: error.message,
      });
    });
  });
}

/**
 * @returns {Promise<import('matrix-bot-sdk').MatrixClient>} resolves once the
 *   client's first sync has completed -- matrix-bot-sdk's own start() promise
 *   contract -- mirroring discord-connection.js's "never resolve before real
 *   work can happen" rule.
 */
async function connect() {
  // A relay-mode process (the worker) must never open its own sync loop on the
  // bot's access token and crypto store -- see matrix-outbound-relay.js. The
  // driver routes around this; reaching it means a caller bypassed the driver.
  // eslint-disable-next-line global-require -- lazy, avoids a load-order cycle
  if (require('./matrix-outbound-relay').isRelayMode()) {
    throw new Error('Matrix connection: this process sends through the relay (matrix-outbound-relay.js) and must not open its own sync connection');
  }
  const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
  const accessToken = process.env.MATRIX_ACCESS_TOKEN;
  if (!homeserverUrl) throw new Error('Matrix connection: MATRIX_HOMESERVER_URL is not set');
  if (!accessToken) throw new Error('Matrix connection: MATRIX_ACCESS_TOKEN is not set');

  // eslint-disable-next-line global-require -- lazy, see file header
  const { MatrixClient, SimpleFsStorageProvider } = require('matrix-bot-sdk');

  const dir = storageDir();
  fs.mkdirSync(dir, { recursive: true });
  const storage = new SimpleFsStorageProvider(path.join(dir, 'bot.json'));
  const cryptoProvider = buildCryptoProvider(dir);

  const freshClient = cryptoProvider
    ? new MatrixClient(homeserverUrl, accessToken, storage, cryptoProvider)
    : new MatrixClient(homeserverUrl, accessToken, storage);

  // Must happen BEFORE start(): matrix-bot-sdk's own `client.dms` (built
  // inside the MatrixClient constructor above) reads `this.client.setAccountData`
  // dynamically at call time, so patching the property here is safe -- but
  // invites (and therefore its internal room.invite handler) can only start
  // arriving once the sync loop is running, so this must be in place first.
  // See the file header comment ("Serialized/retried account data") for why.
  wrapSetAccountDataSerialized(freshClient);
  if (freshClient.crypto) guardEncryptedSends(freshClient);

  // Auto-accepts room invites (a teacher DMing the bot for the first time
  // arrives as an invite the bot must join before it can reply) -- the direct
  // Matrix analogue of Discord requiring no equivalent step at all (a DM
  // channel just exists) and Baileys/Meta having no invite concept.
  //
  // OUR OWN listener, not matrix-bot-sdk's AutojoinRoomsMixin -- its own
  // `room.invite` handler (matrix-bot-sdk/lib/mixins/AutojoinRoomsMixin.js)
  // is `client.on("room.invite", (roomId) => client.joinRoom(roomId))`, with
  // NO try/catch. A join that fails for ANY reason (a stale/foreign invite
  // to a room with no reachable server, a federation hiccup, the bot having
  // already been kicked, ...) throws straight out of an EventEmitter
  // callback and kills the process -- the exact same crash SHAPE as the
  // DMs.persistCache() one this file already guards against, and one this
  // fix's own live burst-test run actually hit (a leftover stale invite in
  // the test homeserver's room list). autojoinRoomInvites() below calls
  // client.joinRoom(roomId) the same way, for invites from an allowed
  // homeserver only, and never lets a failed join escape uncaught.
  autojoinRoomInvites(freshClient);

  try {
    await freshClient.start();
  } catch (error) {
    logToFile('❌ Matrix: failed to start sync -- check MATRIX_HOMESERVER_URL/MATRIX_ACCESS_TOKEN', {
      error: error.message,
    });
    // The next getClient() builds a fresh client (see there); this one must
    // not keep a half-started sync loop running beside it.
    try {
      freshClient.stop();
    } catch (stopError) {
      // best-effort
    }
    throw error;
  }

  client = freshClient;
  connectionState.connected = true;

  try {
    cachedUserId = process.env.MATRIX_USER_ID || await freshClient.getUserId();
  } catch (error) {
    logToFile('⚠️ Matrix: could not resolve own user id via whoami -- set MATRIX_USER_ID explicitly', {
      error: error.message,
    });
  }

  logToFile('✅ Matrix: connected', { homeserverUrl, userId: cachedUserId, e2ee: cryptoEnabled });
  events.emit('open');
  return freshClient;
}

/**
 * Lazily connects on first call; subsequent calls reuse the same connection.
 * Resolves once the first sync has actually completed -- mirrors
 * discord-connection.js's getClient() resolution semantics.
 *
 * A FAILED connect is not cached: callers waiting on that attempt all see its
 * rejection, and the next call tries again. Caching the rejected promise (as
 * this did before) meant one failed connect at boot -- the homeserver still
 * starting in a compose or PaaS deploy of the pair -- left every later send
 * failing and nothing received until the process restarted. The bot's boot
 * also retries the inbound attach with backoff (channel-health.js).
 *
 * @returns {Promise<import('matrix-bot-sdk').MatrixClient>}
 */
function getClient() {
  if (!clientPromise) {
    const attempt = connect().catch((error) => {
      if (clientPromise === attempt) clientPromise = null;
      throw error;
    });
    clientPromise = attempt;
  }
  return clientPromise;
}

function isConnected() {
  return connectionState.connected;
}

/**
 * 'connected' once the first sync completed, 'connecting' while an attempt is
 * in flight, 'down' otherwise (never attempted, failed, or closed). Read by
 * GET /health (channel-health.js#healthReport).
 *
 * @returns {'connected'|'connecting'|'down'}
 */
function connectionStatus() {
  if (connectionState.connected) return 'connected';
  return clientPromise ? 'connecting' : 'down';
}

/** Whether the live connection came up with a working crypto provider (false = plaintext). */
function isE2eeActive() {
  return cryptoEnabled;
}

/** The bot's own Matrix user id, once connected -- used to skip its own echoed messages. Null before connect(). */
function getCachedUserId() {
  return cachedUserId;
}

/**
 * Whether the live client currently considers itself joined to `roomId` --
 * reads matrix-bot-sdk's own live-maintained `lastJoinedRoomIds` array
 * (matrix-bot-sdk/lib/MatrixClient.js), which its sync loop keeps in sync on
 * every room.join/room.leave BEFORE that same sync pass processes any
 * `room.message` events for other rooms (see the leave-rooms-then-invites-
 * then-joined-rooms processing order in its own processSync) -- so this is
 * always at least as fresh as anything a `room.message` handler could have
 * observed, with NO network round trip. Used by matrix-channel.service.js to
 * decide whether a recorded "last room a user messaged us in" is still safe
 * to reply into, or the bot has since left/been kicked from it.
 *
 * `lastJoinedRoomIds` is a private (TS-only) field on the SDK's own class,
 * not part of its public API -- reached into directly the same way this file
 * already reads `client.dms`/`client.storageProvider` elsewhere. Defensively
 * treated as "not joined" if it's ever not an array (a future SDK version
 * renaming/removing it), which is the SAFE direction to fail in: it just
 * means an extra getOrCreateDm() fallback, never a reply into a room the bot
 * cannot actually post to.
 *
 * @param {import('matrix-bot-sdk').MatrixClient} matrixClient
 * @param {string} roomId
 * @returns {boolean}
 */
function isJoinedToRoom(matrixClient, roomId) {
  return Array.isArray(matrixClient?.lastJoinedRoomIds) && matrixClient.lastJoinedRoomIds.includes(roomId);
}

/**
 * Closes the sync connection cleanly. Unlike Baileys (which distinguishes a
 * clean disconnect from a "logged out" one) there is no session-invalidation
 * concept for a long-lived access token -- client.stop() simply halts the
 * /sync loop; nothing about it revokes MATRIX_ACCESS_TOKEN.
 */
async function close() {
  shuttingDown = true;
  try {
    // eslint-disable-next-line global-require -- lazy, see connect()
    require('./matrix-outbound-relay').close();
  } catch (error) {
    logToFile('Matrix: relay close error (ignored)', { error: error.message });
  }
  if (client) {
    try {
      client.stop();
    } catch (error) {
      logToFile('Matrix: stop() error (ignored)', { error: error.message });
    }
  }
  client = null;
  clientPromise = null;
  cachedUserId = null;
  cryptoEnabled = false;
  connectionState.connected = false;
  events.emit('close', { shuttingDown });
}

/** Test-only: forces the next getClient() call to reconnect from scratch. */
function _resetForTests() {
  client = null;
  clientPromise = null;
  cachedUserId = null;
  cryptoEnabled = false;
  connectionState.connected = false;
  shuttingDown = false;
  encryptedRooms.clear();
  events.removeAllListeners();
}

module.exports = {
  getClient,
  isConnected,
  connectionStatus,
  isE2eeActive,
  e2eeMode,
  getCachedUserId,
  isJoinedToRoom,
  roomIsEncrypted,
  close,
  events,
  _resetForTests,
  // Exported for direct unit testing of the serialize/retry seam -- see this
  // file's header comment ("Serialized/retried account data").
  _wrapSetAccountDataSerialized: wrapSetAccountDataSerialized,
  // Exported for direct unit testing of the crash-safe autojoin replacement.
  _autojoinRoomInvites: autojoinRoomInvites,
};
