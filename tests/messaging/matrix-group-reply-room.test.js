/**
 * A reply goes to the room the person used, and a group room never becomes
 * anyone's DM. One message addressed to Rumi in a staff group used to make
 * that group the teacher's "last inbound room" (and, from 566900e, their
 * persisted DM room), so every later private delivery -- a coaching report
 * relayed from the worker, an attendance register, a reminder -- went into
 * the group, where everyone could read it.
 *
 * Real matrix-channel.service.js, matrix-events.adapter.js (driven through
 * attach()'s room.message listener) and matrix-outbound-relay.js; only the
 * matrix-bot-sdk client and Redis (the network boundary) are faked. A
 * "restart" is a fresh module registry over the same storage.
 */

const OWN = '@rumi:localhost';
const T = '@+15550100001:localhost';
const T_ID = 'mtx:15550100001';
const OTHER = '@+15550100002:localhost';
const DM = '!dm:localhost';
const STAFF = '!staff:localhost';
const DM_KEY = `rumi:matrix:dm-room:${T}`;

function fakeRedisServer() {
  const lists = new Map();
  class FakeRedis {
    constructor() { this.closed = false; }

    async lpush(key, value) {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key).unshift(value);
      return lists.get(key).length;
    }

    async brpop(key, timeoutSeconds) {
      const deadline = Date.now() + timeoutSeconds * 1000;
      while (!this.closed) {
        const list = lists.get(key);
        if (list && list.length) return [key, list.pop()];
        if (Date.now() >= deadline) return null;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return null;
    }

    async expire() { return 1; }

    disconnect() { this.closed = true; }
  }
  return { FakeRedis, lists };
}

const member = (userId, membership = 'join') => ({ membershipFor: userId, effectiveMembership: membership });
const ROOM_MEMBERS = {
  [DM]: [member(OWN), member(T)],
  [STAFF]: [member(OWN), member(T), member(OTHER)],
};

const savedRedisUrl = process.env.REDIS_URL;
let relay;

async function boot({ storage = new Map(), reply = 'Here is a warm-up idea.' } = {}) {
  jest.resetModules();
  const redis = fakeRedisServer();
  process.env.REDIS_URL = 'redis://fake:6379';
  // The relay signs and namespaces requests with keys derived from these.
  process.env.MATRIX_ACCESS_TOKEN = 'test-token';
  process.env.MATRIX_HOMESERVER_URL = 'https://matrix.example.org';
  jest.doMock('ioredis', () => redis.FakeRedis);
  jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
  jest.doMock('../../bot/shared/storage/r2', () => ({ downloadFromR2: jest.fn(), extractKeyFromUrl: jest.fn() }));
  jest.doMock('../../bot/shared/services/messaging/pending-options', () => ({
    remember: jest.fn(), get: jest.fn().mockResolvedValue(null), clear: jest.fn(), resolveSelection: jest.fn(() => null),
  }));
  jest.doMock('../../bot/shared/services/messaging/text-flow', () => ({ isActive: jest.fn(async () => false), advance: jest.fn(async () => null) }));
  jest.doMock('../../bot/shared/services/messaging/text-flow-definitions', () => ({ ensureRegistered: jest.fn() }));
  jest.doMock('../../bot/shared/services/attendance-detector.service', () => ({
    detectAddClassIntent: () => ({ detected: false }), detectAttendanceIntent: () => ({ detected: false }),
  }));

  const handlers = {};
  const client = {
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    sendMessage: jest.fn(async () => `$sent${Math.random()}`),
    dms: { getOrCreateDm: jest.fn(async () => DM), isDm: jest.fn((roomId) => roomId === DM) },
    storageProvider: {
      readValue: jest.fn(async (key) => storage.get(key) || null),
      storeValue: jest.fn(async (key, value) => { storage.set(key, value); }),
    },
    getAllRoomMembers: jest.fn(async (roomId) => ROOM_MEMBERS[roomId] || []),
    getRoomStateEvent: jest.fn(async () => ({ name: 'Staff room' })),
    doRequest: jest.fn(async () => ({})),
    getUserId: jest.fn(async () => OWN),
    getUserProfile: jest.fn(async () => ({ displayname: 'Rumi' })),
    joinRoom: jest.fn(async () => { throw new Error('no welcome room'); }),
    resolveRoom: jest.fn(async () => { throw new Error('no welcome room'); }),
  };
  jest.doMock('../../bot/shared/services/messaging/matrix-connection', () => ({
    getClient: jest.fn(async () => client),
    getCachedUserId: () => OWN,
    isE2eeActive: () => false,
    isJoinedToRoom: () => true,
  }));

  relay = require('../../bot/shared/services/messaging/matrix-outbound-relay');
  relay.ownConnectionInThisProcess();
  const service = require('../../bot/shared/services/messaging/matrix-channel.service');
  const adapter = require('../../bot/shared/services/messaging/inbound/matrix-events.adapter');

  // What handleWebhookPost does for a message, reduced to its send: answer
  // the sender. `during` runs while that dispatch is still in flight.
  const hooks = { during: null };
  const dispatch = jest.fn(async (req) => {
    const msg = req.body.entry[0].changes[0].value.messages[0];
    if (hooks.during) await hooks.during();
    await service.sendMessage(msg.from, reply);
  });
  await adapter.attach(dispatch);

  let n = 0;
  const say = (roomId, body) => handlers['room.message'](roomId, {
    sender: T, event_id: `$in${(n += 1)}${Math.random()}`, origin_server_ts: Date.now() + 1000, content: { msgtype: 'm.text', body },
  });
  // A send the worker relays to this process (the coaching report, a register),
  // made through the relay's real, signed caller side.
  const relayed = async (text) => {
    const result = await relay.call('sendMessage', [T_ID, text]);
    return { ok: result !== false, result };
  };
  const roomsSentTo = () => client.sendMessage.mock.calls.map((c) => c[0]);
  return { service, adapter, client, dispatch, say, relayed, hooks, roomsSentTo, storage };
}

afterEach(() => {
  if (relay) relay._resetForTests();
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = savedRedisUrl;
  delete process.env.MATRIX_ACCESS_TOKEN;
  delete process.env.MATRIX_HOMESERVER_URL;
  jest.restoreAllMocks();
});

it('the reply to a message that addressed Rumi in a group goes to that group', async () => {
  const { say, roomsSentTo } = await boot();
  await say(STAFF, 'Rumi, a warm-up idea?');
  expect(roomsSentTo()).toEqual([STAFF]);
});

it('a DM reply goes to the DM', async () => {
  const { say, roomsSentTo } = await boot();
  await say(DM, 'here is my lesson recording');
  expect(roomsSentTo()).toEqual([DM]);
});

it('a private delivery after a group mention still goes to the teacher\'s DM, not the staff group', async () => {
  const { service, say, client } = await boot();
  await say(DM, 'here is my lesson recording');
  await say(STAFF, 'Rumi, a warm-up idea?');
  client.sendMessage.mockClear();
  await service.sendMessage(T_ID, 'Your coaching report: ...');
  expect(client.sendMessage.mock.calls[0][0]).toBe(DM);
});

it('...and it is not bounded by a TTL either: 7 hours later it is still the DM', async () => {
  const { service, say, client } = await boot();
  await say(STAFF, 'Rumi, hello');
  const realNow = Date.now;
  Date.now = () => realNow() + 7 * 3600 * 1000;
  try {
    client.sendMessage.mockClear();
    await service.sendMessage(T_ID, 'Your monthly attendance register');
    expect(client.sendMessage.mock.calls[0][0]).toBe(DM);
  } finally { Date.now = realNow; }
});

it('a relayed send (worker -> bot) after a group mention goes to the DM', async () => {
  const { say, relayed, client } = await boot();
  await say(STAFF, 'Rumi, a warm-up idea?');
  client.sendMessage.mockClear();
  const result = await relayed('Your coaching report: ...');
  expect(result.ok).toBe(true);
  expect(client.sendMessage.mock.calls[0][0]).toBe(DM);
});

it('a relayed send served WHILE the group mention is being answered still goes to the DM', async () => {
  const booted = await boot();
  let relayedResult;
  booted.hooks.during = async () => {
    booted.hooks.during = null;
    relayedResult = await booted.relayed('Your coaching report: ...');
  };
  await booted.say(STAFF, 'Rumi, a warm-up idea?');
  expect(relayedResult.ok).toBe(true);
  // The relayed report first, then the group reply.
  expect(booted.roomsSentTo()).toEqual([DM, STAFF]);
});

it('a send that outlives the group mention\'s handling (e.g. a timer it started) goes to the DM', async () => {
  const booted = await boot();
  let late;
  booted.hooks.during = async () => {
    booted.hooks.during = null;
    late = new Promise((resolve) => setTimeout(() => resolve(booted.service.sendMessage(T_ID, 'a reminder')), 20));
  };
  await booted.say(STAFF, 'Rumi, a warm-up idea?');
  await late;
  expect(booted.roomsSentTo()).toEqual([STAFF, DM]);
});

it('a group room is never persisted as the DM room', async () => {
  const { say, storage, client } = await boot();
  await say(STAFF, 'Rumi, a warm-up idea?');
  const written = client.storageProvider.storeValue.mock.calls.filter(([key]) => key.startsWith('rumi:matrix:dm-room:'));
  expect(written.map(([, value]) => value)).not.toContain(STAFF);
  expect(storage.get(DM_KEY)).not.toBe(STAFF);
});

it('after a restart (same storage), a send goes to the DM -- not the group the teacher last wrote in', async () => {
  const first = await boot();
  await first.say(DM, 'here is my lesson recording');
  await first.say(STAFF, 'Rumi, a warm-up idea?');
  relay._resetForTests();

  const second = await boot({ storage: first.storage });
  await second.service.sendMessage(T_ID, 'Your coaching report: ...');
  expect(second.roomsSentTo()).toEqual([DM]);
});

it('the last DM a teacher wrote from survives a restart', async () => {
  const first = await boot();
  first.client.dms.getOrCreateDm.mockResolvedValue('!other-dm:localhost'); // m.direct lags behind
  await first.say(DM, 'here is my lesson recording');
  relay._resetForTests();

  const second = await boot({ storage: first.storage });
  second.client.dms.getOrCreateDm.mockResolvedValue('!other-dm:localhost');
  await second.service.sendMessage(T_ID, 'your report is ready');
  expect(second.roomsSentTo()).toEqual([DM]);
  expect(second.client.dms.getOrCreateDm).not.toHaveBeenCalled();
});

it('a group room persisted by an earlier version is discarded (checked once per process), and the DM is used', async () => {
  const storage = new Map([[DM_KEY, STAFF]]);
  const { service, client, roomsSentTo } = await boot({ storage });
  await service.sendMessage(T_ID, 'Your coaching report: ...');
  await service.sendMessage(T_ID, 'Your attendance register');
  expect(roomsSentTo()).toEqual([DM, DM]);
  expect(client.dms.getOrCreateDm).toHaveBeenCalledTimes(1);
  expect(client.getAllRoomMembers.mock.calls.filter(([roomId]) => roomId === STAFF)).toHaveLength(1);
  expect(storage.get(DM_KEY)).toBe(DM);
});

it('a room whose membership cannot be read is never recorded, and is answered only when addressed', async () => {
  const { say, client, roomsSentTo, dispatch, adapter } = await boot();
  client.getAllRoomMembers.mockRejectedValue(new Error('homeserver hiccup'));
  await say('!unknown:localhost', 'is the staff room free after lunch?');
  expect(dispatch).not.toHaveBeenCalled();
  await say('!unknown:localhost', 'Rumi, a warm-up idea?');
  expect(roomsSentTo()).toEqual(['!unknown:localhost']);
  expect(adapter.getLastInboundRoom(T)).toBeNull();
  expect([...client.storageProvider.storeValue.mock.calls].map(([, v]) => v)).not.toContain('!unknown:localhost');
});
