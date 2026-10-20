/**
 * matrix-connection.js -- the persistent Matrix sync connection manager.
 *
 * `matrix-bot-sdk` is a real package that opens real network sync loops, so
 * it's virtually mocked here the same way discord-connection.test.js mocks
 * `discord.js` -- a real sync call must never happen from a unit test
 * regardless of whether the package happens to be installed.
 *
 * The E2EE fallback (buildCryptoProvider) is the fact this suite most cares
 * about pinning down: a missing/broken native crypto module must degrade to
 * plaintext with a warning, never throw and never crash boot.
 */

const SDK_DIR = require('path').join(__dirname, '../../bot/node_modules/matrix-bot-sdk');
const SDK_INSTALLED = require('fs').existsSync(require('path').join(SDK_DIR, 'package.json'));
const SDK_MAIN = SDK_INSTALLED ? require('fs').realpathSync(require.resolve(SDK_DIR)) : null;

// matrix-bot-sdk@0.8.0's own real exports for this area are `CryptoClient`,
// `requiresCrypto`, `RustSdkCryptoStorageProvider`, and
// `RustSdkAppserviceCryptoStorageProvider` -- NOT a `StoreType`/
// `RustSdkCryptoStoreType` value. That enum lives on the separate
// `@matrix-org/matrix-sdk-crypto-nodejs` package instead (see
// matrix-connection.js's own header comment for the real bug this was
// getting wrong before). This mock intentionally mirrors ONLY the real
// exports, so a regression back to importing StoreType from matrix-bot-sdk
// fails loudly here instead of silently passing against a too-generous mock.
function mockMatrixSdk({ startImpl, getUserIdImpl, joinRoomImpl } = {}) {
  // A minimal real EventEmitter (not a jest.fn() stub) so tests can actually
  // fire 'room.invite' and observe how connect()'s own listener (see
  // autojoinRoomInvites()) reacts -- matches how the real MatrixClient's
  // `on`/emit works.
  const EventEmitter = require('events');
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    start: jest.fn(startImpl || (async () => undefined)),
    stop: jest.fn(),
    getUserId: jest.fn(getUserIdImpl || (async () => '@rumi:example.org')),
    joinRoom: jest.fn(joinRoomImpl || (async () => undefined)),
    // connect() always wraps this (see matrix-connection.js's
    // wrapSetAccountDataSerialized) -- a real MatrixClient always has it.
    setAccountData: jest.fn(async () => undefined),
  });
  const MatrixClient = jest.fn(() => client);
  const SimpleFsStorageProvider = jest.fn();
  const RustSdkCryptoStorageProvider = jest.fn(() => ({}));

  const factory = () => ({
    MatrixClient,
    SimpleFsStorageProvider,
    RustSdkCryptoStorageProvider,
  });
  // Where bot/node_modules has the real package, mock it by its real path:
  // jest's resolver caches a bare name's resolution per worker, across test
  // files, so a virtual bare-name mock is silently skipped after a suite that
  // loaded the real SDK (matrix-encrypted-send-guard.test.js) ran first.
  if (SDK_INSTALLED) jest.doMock(SDK_MAIN, factory);
  else jest.doMock('matrix-bot-sdk', factory, { virtual: true });
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));

  return { MatrixClient, client, SimpleFsStorageProvider, RustSdkCryptoStorageProvider };
}

// buildCryptoProvider() reads StoreType from matrix-crypto-module.js, which
// finds the crypto package matrix-bot-sdk ITSELF loads (its nested copy). The
// error-handling tests below stub that loader, so they also run in the root
// CI pass, before bot/ dependencies are installed; the one test that needs the
// real nested package runs only where bot/node_modules has it.
const CRYPTO_MODULE = '../../bot/shared/services/messaging/matrix-crypto-module';

function mockCryptoLoader(load) {
  jest.doMock(CRYPTO_MODULE, () => ({ loadSdkCryptoModule: load }));
}

function mockCryptoAvailable() {
  mockCryptoLoader(() => ({ StoreType: { Sqlite: 0 } }));
}

/** Simulates the package genuinely being absent (e.g. no matching prebuilt binary): a real MODULE_NOT_FOUND. */
function mockCryptoModuleAbsent() {
  mockCryptoLoader(() => {
    const error = new Error('Cannot find module \'@matrix-org/matrix-sdk-crypto-nodejs\'');
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  });
}

/**
 * Hides only the TOP-LEVEL @matrix-org/matrix-sdk-crypto-nodejs (what a test
 * file, or bot code, resolves by bare name) -- matrix-bot-sdk's own nested
 * copy stays real, exactly as on a host where npm skipped an optional copy.
 * The loader itself is the real one.
 */
function mockTopLevelCryptoHidden() {
  jest.dontMock(CRYPTO_MODULE); // a doMock from an earlier test outlives jest.resetModules()
  const absent = () => {
    const error = new Error('Cannot find module \'@matrix-org/matrix-sdk-crypto-nodejs\'');
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  };
  // What bot code would get from a bare require: bot/node_modules' top-level
  // copy, when an older install still has one.
  const topLevel = require('path').join(__dirname, '../../bot/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.js');
  if (require('fs').existsSync(topLevel)) jest.doMock(require('fs').realpathSync(topLevel), absent);
  jest.doMock('@matrix-org/matrix-sdk-crypto-nodejs', absent, { virtual: true });
}

/** Simulates a REAL bug (e.g. a wrong import, corrupted store) -- present, but broken for some other reason. */
function mockCryptoModuleBroken() {
  mockCryptoLoader(() => {
    throw new TypeError('boom: some other failure, not a missing module');
  });
}

beforeEach(() => {
  jest.resetModules();
  process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.org';
  process.env.MATRIX_ACCESS_TOKEN = 'test-token';
  delete process.env.MATRIX_USER_ID;
  delete process.env.MATRIX_E2EE;
  delete process.env.MATRIX_STORAGE_DIR;
});

afterEach(() => {
  jest.resetModules();
  delete process.env.MATRIX_HOMESERVER_URL;
  delete process.env.MATRIX_ACCESS_TOKEN;
  delete process.env.MATRIX_USER_ID;
  delete process.env.MATRIX_E2EE;
  delete process.env.MATRIX_STORAGE_DIR;
});

describe('matrix-connection', () => {
  it('connects lazily: requiring the module does not call MatrixClient or start()', () => {
    const { MatrixClient, client } = mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    require('../../bot/shared/services/messaging/matrix-connection');
    expect(MatrixClient).not.toHaveBeenCalled();
    expect(client.start).not.toHaveBeenCalled();
  });

  it('getClient() resolves once start() resolves, with a working crypto provider when available', async () => {
    const { MatrixClient, client, RustSdkCryptoStorageProvider } = mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    const result = await conn.getClient();
    expect(result).toBe(client);
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(RustSdkCryptoStorageProvider).toHaveBeenCalledTimes(1);
    // StoreType.Sqlite (0) comes from @matrix-org/matrix-sdk-crypto-nodejs
    // (matrix-bot-sdk's own copy), NOT from matrix-bot-sdk's exports -- the
    // exact bug this pins down.
    expect(RustSdkCryptoStorageProvider.mock.calls[0][1]).toBe(0);
    // 4-arg constructor form (homeserverUrl, accessToken, storage, cryptoStore) when crypto is available.
    expect(MatrixClient.mock.calls[0]).toHaveLength(4);
    expect(conn.isE2eeActive()).toBe(true);
  });

  // Encryption fails closed: with MATRIX_E2EE unset the channel used to start
  // in plaintext with only a log line, on every host without crypto. Now only
  // an explicit MATRIX_E2EE=off starts without encryption.
  it('MATRIX_E2EE unset: REFUSES to start when the crypto module is genuinely absent, naming the off switch', async () => {
    const { client } = mockMatrixSdk();
    mockCryptoModuleAbsent();
    const logger = require('../../bot/shared/utils/logger');
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/refusing to start without encryption.*reinstall bot dependencies.*MATRIX_E2EE=off/s);
    expect(client.start).not.toHaveBeenCalled();
    expect(conn.isConnected()).toBe(false);
    expect(logger.logToFile).toHaveBeenCalledWith(
      expect.stringContaining('is not installed on this host'),
      expect.objectContaining({ error: expect.any(String), code: 'MODULE_NOT_FOUND' })
    );
  });

  it('MATRIX_E2EE unset: a REAL bug (not module-absent) also refuses to start, logged at error level with the real message/code', async () => {
    mockMatrixSdk();
    mockCryptoModuleBroken();
    const logger = require('../../bot/shared/utils/logger');
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/refusing to start without encryption/);
    expect(logger.logToFile).toHaveBeenCalledWith(
      expect.stringContaining('this is a bug, not an environment limitation'),
      expect.objectContaining({
        error: expect.stringContaining('boom: some other failure'),
        code: undefined, // TypeError has no .code, distinguishing it from MODULE_NOT_FOUND
        level: 'error',
      })
    );
    // Never the module-absent wording for a real bug.
    expect(logger.logToFile).not.toHaveBeenCalledWith(
      expect.stringContaining('is not installed on this host'),
      expect.anything()
    );
  });

  it('the old MATRIX_E2EE=auto value no longer downgrades quietly: it is treated as "on"', async () => {
    mockMatrixSdk();
    mockCryptoModuleAbsent();
    process.env.MATRIX_E2EE = 'auto';
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/refusing to start without encryption/);
  });

  it('e2eeMode() reports "on" unless MATRIX_E2EE is exactly "off"', () => {
    const conn = require('../../bot/shared/services/messaging/matrix-connection');
    for (const value of [undefined, '', 'on', 'auto', 'ON', 'yes']) {
      if (value === undefined) delete process.env.MATRIX_E2EE; else process.env.MATRIX_E2EE = value;
      expect(conn.e2eeMode()).toBe('on');
    }
    process.env.MATRIX_E2EE = ' Off ';
    expect(conn.e2eeMode()).toBe('off');
  });

  it('MATRIX_E2EE=on: FAILS startup (throws) instead of silently downgrading when the module is genuinely absent', async () => {
    mockMatrixSdk();
    mockCryptoModuleAbsent();
    process.env.MATRIX_E2EE = 'on';
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/refusing to start without encryption/);
    expect(conn.isConnected()).toBe(false);
  });

  it('MATRIX_E2EE=on: FAILS startup (throws) instead of silently downgrading on a real bug too, not just module-absent', async () => {
    mockMatrixSdk();
    mockCryptoModuleBroken();
    process.env.MATRIX_E2EE = 'on';
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/refusing to start without encryption/);
  });

  // matrix-bot-sdk@0.8.0 encrypts with its OWN nested copy of the crypto
  // package (0.4.0, Node 22+). A top-level copy (an optional dependency some
  // installs skip) must not decide whether encryption can start.
  (SDK_INSTALLED ? it : it.skip)('builds the crypto provider from matrix-bot-sdk\'s own crypto package when no top-level copy is installed', async () => {
    const { client, RustSdkCryptoStorageProvider } = mockMatrixSdk();
    mockTopLevelCryptoHidden();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).resolves.toBe(client);
    expect(RustSdkCryptoStorageProvider).toHaveBeenCalledWith(expect.stringMatching(/crypto$/), 0);
    expect(conn.isE2eeActive()).toBe(true);
  });

  it('MATRIX_E2EE=off skips the crypto attempt entirely, without even trying to require the native module', async () => {
    const { MatrixClient } = mockMatrixSdk();
    process.env.MATRIX_E2EE = 'off';
    // No @matrix-org/matrix-sdk-crypto-nodejs mock at all -- if the code tried
    // to require it, this would blow up with a real MODULE_NOT_FOUND rather
    // than politely no-op, so an unhandled failure here IS the assertion.
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await conn.getClient();
    expect(MatrixClient.mock.calls[0]).toHaveLength(3);
    expect(conn.isE2eeActive()).toBe(false);
  });

  it('getClient() is memoized -- a second call reuses the same connection without reconnecting', async () => {
    const { MatrixClient } = mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    const first = await conn.getClient();
    const second = await conn.getClient();
    expect(first).toBe(second);
    expect(MatrixClient).toHaveBeenCalledTimes(1);
  });

  it('auto-accepts a room invite by joining it', async () => {
    const { client } = mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await conn.getClient();
    client.emit('room.invite', '!room:example.org', { sender: '@teacher:example.org' });
    await Promise.resolve(); // let the fire-and-forget joinRoom().catch(...) chain settle

    expect(client.joinRoom).toHaveBeenCalledWith('!room:example.org');
  });

  // Replaces matrix-bot-sdk's own AutojoinRoomsMixin.setupOnClient(), whose
  // `room.invite` listener has NO try/catch around client.joinRoom(roomId) --
  // a failed join (stale/foreign invite, federation hiccup, already-kicked,
  // ...) throws straight out of an EventEmitter callback and kills the
  // process. See matrix-connection.js#autojoinRoomInvites's own header
  // comment for the live crash this pins down.
  it('a failed join does NOT throw/reject out of the room.invite listener -- it is caught and logged', async () => {
    const joinError = new Error("Can't join remote room because no servers that are in the room have been provided.");
    const { client } = mockMatrixSdk({ joinRoomImpl: async () => { throw joinError; } });
    mockCryptoAvailable();
    const logger = require('../../bot/shared/utils/logger');
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await conn.getClient();

    // If autojoinRoomInvites() ever regresses to the SDK's own uncaught
    // shape, this listener itself throwing/rejecting would surface as an
    // unhandled rejection in the test process -- there is nothing else here
    // to catch it, which is exactly the point.
    client.emit('room.invite', '!stale:example.org', { sender: '@ghost:example.org' });
    await Promise.resolve();
    await Promise.resolve();

    expect(client.joinRoom).toHaveBeenCalledWith('!stale:example.org');
    expect(logger.logToFile).toHaveBeenCalledWith(
      expect.stringContaining('failed to auto-join an invited room'),
      expect.objectContaining({ channel: 'matrix', roomId: '!stale:example.org', error: joinError.message })
    );
  });

  it('throws when MATRIX_HOMESERVER_URL is not set', async () => {
    mockMatrixSdk();
    mockCryptoAvailable();
    delete process.env.MATRIX_HOMESERVER_URL;
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/MATRIX_HOMESERVER_URL/);
  });

  it('throws when MATRIX_ACCESS_TOKEN is not set', async () => {
    mockMatrixSdk();
    mockCryptoAvailable();
    delete process.env.MATRIX_ACCESS_TOKEN;
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/MATRIX_ACCESS_TOKEN/);
  });

  it('propagates a start() rejection (bad/revoked token) rather than hanging', async () => {
    const { client } = mockMatrixSdk({ startImpl: async () => { throw new Error('M_UNKNOWN_TOKEN'); } });
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow(/M_UNKNOWN_TOKEN/);
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  // A homeserver still starting when the bot starts (a compose or Railway
  // deploy of the pair) must not leave Matrix down until the next restart.
  it('a homeserver that was down at boot can be reached once it is up', async () => {
    let calls = 0;
    const { client } = mockMatrixSdk({
      startImpl: async () => { calls += 1; if (calls === 1) throw new Error('connect ECONNREFUSED'); },
    });
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await expect(conn.getClient()).rejects.toThrow('ECONNREFUSED');
    // The homeserver is up now; the next send asks for the client again.
    await expect(conn.getClient()).resolves.toBe(client);
    expect(client.start).toHaveBeenCalledTimes(2);
  });

  it('connectionStatus() reports down before any attempt, connecting while one runs, connected after', async () => {
    let finishStart;
    mockMatrixSdk({ startImpl: () => new Promise((resolve) => { finishStart = resolve; }) });
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    expect(conn.connectionStatus()).toBe('down');
    const pending = conn.getClient();
    expect(conn.connectionStatus()).toBe('connecting');
    await new Promise((resolve) => setImmediate(resolve));
    finishStart();
    await pending;
    expect(conn.connectionStatus()).toBe('connected');
  });

  it('resolves the own user id via whoami when MATRIX_USER_ID is not set', async () => {
    mockMatrixSdk({ getUserIdImpl: async () => '@rumi:example.org' });
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await conn.getClient();
    expect(conn.getCachedUserId()).toBe('@rumi:example.org');
  });

  it('prefers an explicit MATRIX_USER_ID over whoami', async () => {
    const { client } = mockMatrixSdk();
    mockCryptoAvailable();
    process.env.MATRIX_USER_ID = '@configured:example.org';
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await conn.getClient();
    expect(conn.getCachedUserId()).toBe('@configured:example.org');
    expect(client.getUserId).not.toHaveBeenCalled();
  });

  it('marks isConnected() true once started, false after close()', async () => {
    mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    expect(conn.isConnected()).toBe(false);
    await conn.getClient();
    expect(conn.isConnected()).toBe(true);

    await conn.close();
    expect(conn.isConnected()).toBe(false);
  });

  it('close() calls client.stop() and lets a fresh getClient() reconnect afterward', async () => {
    const { MatrixClient, client } = mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    await conn.getClient();
    await conn.close();
    expect(client.stop).toHaveBeenCalledTimes(1);

    await conn.getClient();
    expect(MatrixClient).toHaveBeenCalledTimes(2);
  });

  it('close() is safe when no connection was ever opened', async () => {
    mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it('events emitter fires "open" on connect and "close" on close()', async () => {
    mockMatrixSdk();
    mockCryptoAvailable();
    require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
    const conn = require('../../bot/shared/services/messaging/matrix-connection');

    const opens = jest.fn();
    const closes = jest.fn();
    conn.events.on('open', opens);
    conn.events.on('close', closes);

    await conn.getClient();
    expect(opens).toHaveBeenCalledTimes(1);

    await conn.close();
    expect(closes).toHaveBeenCalledTimes(1);
  });
});
