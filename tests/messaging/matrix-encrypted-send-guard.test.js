/**
 * Sends into an encrypted room never fall back to plaintext.
 *
 * matrix-bot-sdk's RoomTracker reads a room's m.room.encryption state the
 * first time the bot sends there and, when that request FAILS (a 502, a
 * timeout), it returns "no encryption" (RoomTracker.js: `catch (e) { return;
 * // failure == no encryption }`) -- and MatrixClient#sendEvent then sends the
 * event, or the attachment, unencrypted. matrix-connection.js confirms the
 * room's state itself before any send in that case.
 *
 * This suite runs the REAL chain: matrix-connection.js#connect() builds a real
 * matrix-bot-sdk MatrixClient with a real crypto store, CryptoClient and
 * RoomTracker, and the sends go through matrix-channel.service.js's own
 * methods. Only the network is faked: the SDK's HTTP function (its own
 * setRequestFn test seam), plus start() (the /sync loop) and the Olm
 * encryption step, which need a live homeserver. Needs bot/ dependencies, so
 * it is skipped in the root CI pass that runs before they are installed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SDK_DIR = path.join(__dirname, '../../bot/node_modules/matrix-bot-sdk');
const SDK_INSTALLED = fs.existsSync(path.join(SDK_DIR, 'package.json'));

const TO = 'matrix:@teacher:example.org';
const ROOM = '!dm:example.org';
const ENCRYPTION_STATE = `/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/state/m.room.encryption/`;

/**
 * A fake homeserver behind the SDK's own request function. `encryptionState`
 * decides what GET …/state/m.room.encryption answers (502, 404 or 200; an
 * array answers one request at a time); it can be changed between sends.
 */
function fakeHomeserver() {
  const server = { encryptionState: 502, requests: [] };
  server.request = (params, callback) => {
    const url = new URL(params.uri);
    const call = { method: params.method, path: url.pathname, body: typeof params.body === 'string' ? JSON.parse(params.body) : params.body || null };
    server.requests.push(call);
    const reply = (statusCode, body) => setImmediate(() => callback(null, { statusCode, body: JSON.stringify(body) }, JSON.stringify(body)));

    if (call.method === 'GET' && call.path === ENCRYPTION_STATE) {
      const state = Array.isArray(server.encryptionState) ? server.encryptionState.shift() : server.encryptionState;
      if (state === 502) {
        // A reverse proxy's error page: not JSON, no errcode.
        setImmediate(() => callback(null, { statusCode: 502, body: '<html>502 Bad Gateway</html>' }, '<html>502 Bad Gateway</html>'));
        return;
      }
      if (state === 404) return reply(404, { errcode: 'M_NOT_FOUND', error: 'Event not found.' });
      return reply(200, { algorithm: 'm.megolm.v1.aes-sha2' });
    }
    if (call.method === 'GET' && /\/state\/m\.room\.history_visibility\/$/.test(call.path)) {
      return reply(200, { history_visibility: 'shared' });
    }
    if (call.method === 'GET' && /\/members$/.test(call.path)) {
      // The stored DM room is checked to be a 1:1 with the teacher before use.
      const member = (userId) => ({
        type: 'm.room.member', state_key: userId, sender: userId, event_id: `$member-${userId}`,
        room_id: ROOM, content: { membership: 'join' },
      });
      return reply(200, { chunk: [member('@rumi:example.org'), member('@teacher:example.org')] });
    }
    if (call.method === 'PUT' && /\/send\//.test(call.path)) return reply(200, { event_id: `$event${server.requests.length}` });
    if (call.method === 'POST' && /\/media\/v3\/upload/.test(call.path)) return reply(200, { content_uri: 'mxc://example.org/media1' });
    return reply(404, { errcode: 'M_UNRECOGNIZED', error: 'not faked' });
  };
  server.sends = () => server.requests.filter((r) => r.method === 'PUT' && /\/send\//.test(r.path));
  server.uploads = () => server.requests.filter((r) => r.method === 'POST' && /\/upload/.test(r.path));
  server.encryptionLookups = () => server.requests.filter((r) => r.method === 'GET' && r.path === ENCRYPTION_STATE);
  return server;
}

async function bootChannel(server) {
  jest.resetModules();
  process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.org';
  process.env.MATRIX_ACCESS_TOKEN = 'test-token';
  process.env.MATRIX_USER_ID = '@rumi:example.org';
  process.env.MATRIX_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-send-guard-'));
  delete process.env.MATRIX_E2EE;

  const sdkMain = fs.realpathSync(require.resolve(SDK_DIR));
  // The same module instance matrix-connection.js loads. The /sync loop (and
  // the crypto bootstrap it runs) needs a live homeserver, so start() is a no-op.
  require(sdkMain).MatrixClient.prototype.start = async function noSync() {};
  require(path.join(path.dirname(sdkMain), 'request')).setRequestFn(server.request);

  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/services/messaging/pending-options', () => ({
    remember: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    clear: jest.fn().mockResolvedValue(undefined),
    resolveSelection: jest.fn(() => null),
  }));
  jest.doMock('../../bot/shared/services/cache/railway-redis.service', () => ({
    set: jest.fn().mockRejectedValue(new Error('redis disabled in tests')),
    get: jest.fn().mockRejectedValue(new Error('redis disabled in tests')),
    delete: jest.fn().mockRejectedValue(new Error('redis disabled in tests')),
  }));

  require('../../bot/shared/services/messaging/matrix-outbound-relay').ownConnectionInThisProcess(); // this test plays the bot, the connection owner
  const connection = require('../../bot/shared/services/messaging/matrix-connection');
  const client = await connection.getClient();
  expect(client.crypto).toBeTruthy(); // the real CryptoClient, with its real RoomTracker
  // The real start() ends with crypto.prepare(), which marks the CryptoClient
  // ready; Olm encryption itself needs keys from a live homeserver. The
  // DECISION to encrypt (RoomTracker, sendEvent) stays real.
  client.crypto.ready = true;
  client.crypto.encryptRoomEvent = jest.fn(async () => ({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'CIPHERTEXT' }));
  await client.storageProvider.storeValue(`rumi:matrix:dm-room:${TO.slice('matrix:'.length)}`, ROOM);

  const service = require('../../bot/shared/services/messaging/matrix-channel.service');
  const logger = require('../../bot/shared/utils/logger');
  return { service, client, logger };
}

afterEach(() => {
  jest.resetModules();
  for (const key of ['MATRIX_HOMESERVER_URL', 'MATRIX_ACCESS_TOKEN', 'MATRIX_USER_ID', 'MATRIX_STORAGE_DIR']) delete process.env[key];
});

(SDK_INSTALLED ? describe : describe.skip)('Matrix sends with E2EE on: a room is never assumed unencrypted', () => {
  it('a failed encryption-state lookup (502) refuses the send: nothing goes out in plaintext, and the send returns false', async () => {
    const server = fakeHomeserver();
    server.encryptionState = 502;
    const { service, logger } = await bootChannel(server);

    await expect(service.sendMessage(TO, 'a private lesson note')).resolves.toBe(false);
    await expect(service.sendReaction(TO, '$teacher-message', '👍')).resolves.toBe(false);
    await expect(service.sendAudio(TO, Buffer.alloc(64))).resolves.toBe(false);

    expect(server.sends()).toEqual([]);
    expect(server.uploads()).toEqual([]);
    expect(logger.logToFile).toHaveBeenCalledWith(
      expect.stringContaining('refusing to send'),
      expect.objectContaining({ roomId: ROOM, level: 'error' })
    );
  });

  it('a failure is not remembered: once the homeserver answers, the next send goes out encrypted', async () => {
    const server = fakeHomeserver();
    server.encryptionState = 502;
    const { service } = await bootChannel(server);
    await expect(service.sendMessage(TO, 'first try')).resolves.toBe(false);

    server.encryptionState = 200;
    await expect(service.sendMessage(TO, 'second try')).resolves.toBe(true);

    expect(server.sends()).toHaveLength(1);
    expect(server.sends()[0].path).toMatch(/\/send\/m\.room\.encrypted\//);
    expect(server.sends()[0].body).toEqual({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'CIPHERTEXT' });
  });

  it('when only the SDK\'s own lookup fails and ours finds the room encrypted, the SDK is told and the send is encrypted', async () => {
    const server = fakeHomeserver();
    server.encryptionState = [502, 200]; // RoomTracker's lookup, then matrix-connection.js's
    const { service, client } = await bootChannel(server);

    await expect(service.sendMessage(TO, 'hello')).resolves.toBe(true);

    expect(server.encryptionLookups()).toHaveLength(2);
    expect(server.sends()).toHaveLength(1);
    expect(server.sends()[0].path).toMatch(/\/send\/m\.room\.encrypted\//);
    await expect(client.crypto.isRoomEncrypted(ROOM)).resolves.toBe(true);
  });

  it('M_NOT_FOUND (the room genuinely has no encryption) allows a plaintext send', async () => {
    const server = fakeHomeserver();
    server.encryptionState = 404;
    const { service } = await bootChannel(server);

    await expect(service.sendMessage(TO, 'hello')).resolves.toBe(true);

    expect(server.sends()).toHaveLength(1);
    expect(server.sends()[0].path).toMatch(/\/send\/m\.room\.message\//);
    expect(server.sends()[0].body.body).toBe('hello');
  });

  it('an encrypted room (200) is sent encrypted, and the verdict is remembered', async () => {
    const server = fakeHomeserver();
    server.encryptionState = 200;
    const { service } = await bootChannel(server);

    await expect(service.sendMessage(TO, 'one')).resolves.toBe(true);
    await expect(service.sendMessage(TO, 'two')).resolves.toBe(true);

    expect(server.sends().map((s) => s.path)).toEqual([
      expect.stringMatching(/\/send\/m\.room\.encrypted\//),
      expect.stringMatching(/\/send\/m\.room\.encrypted\//),
    ]);
    expect(server.sends().some((s) => /\/send\/m\.room\.message\//.test(s.path))).toBe(false);
    expect(server.encryptionLookups()).toHaveLength(1);
  });

  it('an attachment into an encrypted room is encrypted before upload', async () => {
    const server = fakeHomeserver();
    server.encryptionState = 200;
    const { service, client } = await bootChannel(server);
    client.crypto.encryptMedia = jest.fn(async () => ({
      buffer: Buffer.from('ciphertext'),
      file: { key: { k: 'secret' }, iv: 'iv', hashes: { sha256: 'h' }, v: 'v2' },
    }));

    await expect(service.sendAudio(TO, Buffer.alloc(64))).resolves.toBe(true);

    expect(client.crypto.encryptMedia).toHaveBeenCalled();
    expect(server.sends()[0].path).toMatch(/\/send\/m\.room\.encrypted\//);
  });
});
