/**
 * Who can reach Rumi on Matrix: only users on an allowed homeserver -- the
 * bot's own server, plus any listed in MATRIX_ALLOWED_SERVERS. On a Synapse
 * with federation on (its default), anyone on any other server could
 * otherwise invite the bot and talk to it. Covers the three ways in:
 *  - an invite (matrix-connection.js#autojoinRoomInvites): joined only from an
 *    allowed server, otherwise declined;
 *  - a room.message (matrix-events.adapter.js#attach): dropped before the
 *    marker, the group gate, the room record and dispatch;
 *  - a join in the welcome room / a pending welcome DM: no DM opened.
 * Only the matrix-bot-sdk client (the network boundary) is faked.
 */

const EventEmitter = require('events');

const OWN = '@rumi:localhost';
const LOCAL_TEACHER = '@+15550100001:localhost';
const FOREIGN_TEACHER = '@+15550100001:other.example.org';

afterEach(() => {
  delete process.env.MATRIX_USER_ID;
  delete process.env.MATRIX_ALLOWED_SERVERS;
  jest.resetModules();
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('invites', () => {
  function load() {
    jest.resetModules();
    const logToFile = jest.fn();
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile }));
    const connection = require('../../bot/shared/services/messaging/matrix-connection');
    const client = Object.assign(new EventEmitter(), {
      joinRoom: jest.fn(async () => undefined),
      leaveRoom: jest.fn(async () => undefined),
      getUserId: jest.fn(async () => OWN),
    });
    connection._autojoinRoomInvites(client);
    return { client, logToFile };
  }

  it('joins an invite from the bot\'s own server', async () => {
    process.env.MATRIX_USER_ID = OWN;
    const { client } = load();
    client.emit('room.invite', '!dm:localhost', { sender: LOCAL_TEACHER });
    await flush();
    expect(client.joinRoom).toHaveBeenCalledWith('!dm:localhost');
    expect(client.leaveRoom).not.toHaveBeenCalled();
  });

  it('declines an invite from a server that is not allowed, and logs the inviter once', async () => {
    process.env.MATRIX_USER_ID = OWN;
    const { client, logToFile } = load();
    client.emit('room.invite', '!a:other.example.org', { sender: FOREIGN_TEACHER });
    client.emit('room.invite', '!b:other.example.org', { sender: FOREIGN_TEACHER });
    await flush();
    expect(client.joinRoom).not.toHaveBeenCalled();
    expect(client.leaveRoom).toHaveBeenCalledWith('!a:other.example.org');
    expect(client.leaveRoom).toHaveBeenCalledWith('!b:other.example.org');
    const declines = logToFile.mock.calls.filter(([msg]) => /declined an invite/.test(msg));
    expect(declines).toHaveLength(1);
    expect(declines[0][1]).toEqual(expect.objectContaining({ channel: 'matrix', inviter: FOREIGN_TEACHER }));
  });

  it('joins an invite from a server listed in MATRIX_ALLOWED_SERVERS', async () => {
    process.env.MATRIX_USER_ID = OWN;
    process.env.MATRIX_ALLOWED_SERVERS = 'localhost,other.example.org';
    const { client } = load();
    client.emit('room.invite', '!a:other.example.org', { sender: FOREIGN_TEACHER });
    await flush();
    expect(client.joinRoom).toHaveBeenCalledWith('!a:other.example.org');
  });

  it('works out the own server via whoami when MATRIX_USER_ID is not set', async () => {
    const { client } = load();
    client.emit('room.invite', '!dm:localhost', { sender: LOCAL_TEACHER });
    client.emit('room.invite', '!a:other.example.org', { sender: FOREIGN_TEACHER });
    await flush();
    expect(client.joinRoom).toHaveBeenCalledTimes(1);
    expect(client.joinRoom).toHaveBeenCalledWith('!dm:localhost');
  });

  it('joins nothing when the own server cannot be worked out', async () => {
    const { client } = load();
    client.getUserId.mockRejectedValue(new Error('whoami failed'));
    client.emit('room.invite', '!dm:localhost', { sender: LOCAL_TEACHER });
    await flush();
    expect(client.joinRoom).not.toHaveBeenCalled();
  });
});

describe('room.message', () => {
  async function attach() {
    jest.resetModules();
    const logToFile = jest.fn();
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile }));
    jest.doMock('../../bot/shared/services/messaging/matrix-channel.service', () => ({ _cacheIncomingMedia: jest.fn() }));
    jest.doMock('../../bot/shared/services/messaging/pending-options', () => ({
      get: jest.fn().mockResolvedValue(null), resolveSelection: jest.fn(() => null), clear: jest.fn(),
    }));
    jest.doMock('../../bot/shared/services/messaging/text-flow', () => ({ isActive: jest.fn(async () => false), advance: jest.fn(async () => null) }));
    jest.doMock('../../bot/shared/services/messaging/text-flow-definitions', () => ({ ensureRegistered: jest.fn() }));
    jest.doMock('../../bot/shared/services/attendance-detector.service', () => ({
      detectAddClassIntent: () => ({ detected: false }), detectAttendanceIntent: () => ({ detected: false }),
    }));
    const handlers = {};
    const client = {
      on: jest.fn((event, handler) => { handlers[event] = handler; }),
      storageProvider: { readValue: jest.fn(async () => null), storeValue: jest.fn(async () => undefined) },
      getUserId: jest.fn(async () => OWN),
      getUserProfile: jest.fn(async () => ({ displayname: 'Rumi' })),
      joinRoom: jest.fn(async () => { throw new Error('no welcome room'); }),
      resolveRoom: jest.fn(async () => { throw new Error('no welcome room'); }),
      getAllRoomMembers: jest.fn(async () => [{ effectiveMembership: 'join' }, { effectiveMembership: 'join' }]),
      dms: { isDm: jest.fn(() => true) },
    };
    jest.doMock('../../bot/shared/services/messaging/matrix-connection', () => ({
      getClient: jest.fn(async () => client),
      getCachedUserId: jest.fn(() => OWN),
    }));
    jest.doMock('../../bot/shared/services/messaging/matrix-outbound-relay', () => ({ startOwner: jest.fn(() => true) }));
    const adapter = require('../../bot/shared/services/messaging/inbound/matrix-events.adapter');
    const dispatch = jest.fn(async () => undefined);
    await adapter.attach(dispatch);
    const send = (roomId, sender, id) => handlers['room.message'](roomId, {
      sender, event_id: id, origin_server_ts: Date.now() + 1000, content: { msgtype: 'm.text', body: 'here is my lesson recording' },
    });
    return { adapter, client, dispatch, send, logToFile };
  }

  const dispatchedFrom = (dispatch) => dispatch.mock.calls.map((c) => c[0].body.entry[0].changes[0].value.messages[0].from);

  it('a message from a server that is not allowed is never dispatched, recorded or marked processed', async () => {
    const { adapter, client, dispatch, send, logToFile } = await attach();
    await send('!dm:other.example.org', FOREIGN_TEACHER, '$foreign1');
    expect(dispatch).not.toHaveBeenCalled();
    expect(client.storageProvider.storeValue).not.toHaveBeenCalled(); // no marker write
    expect(client.getAllRoomMembers).not.toHaveBeenCalled(); // never reached the group gate
    expect(adapter.getLastInboundRoom(FOREIGN_TEACHER)).toBeNull();
    const drop = logToFile.mock.calls.find(([msg]) => /not an allowed homeserver/.test(msg));
    expect(drop[1]).toEqual(expect.objectContaining({ channel: 'matrix', roomId: '!dm:other.example.org', eventId: '$foreign1' }));
    expect(JSON.stringify(drop[1])).not.toContain('lesson recording'); // no body
  });

  it('a message from the own server is dispatched with the short identity', async () => {
    const { dispatch, send } = await attach();
    await send('!dm:localhost', LOCAL_TEACHER, '$local1');
    expect(dispatchedFrom(dispatch)).toEqual(['mtx:15550100001']);
  });

  it('a message from a server listed in MATRIX_ALLOWED_SERVERS is dispatched, with the long identity', async () => {
    process.env.MATRIX_ALLOWED_SERVERS = 'localhost,other.example.org';
    const { dispatch, send } = await attach();
    await send('!dm:other.example.org', FOREIGN_TEACHER, '$foreign2');
    expect(dispatchedFrom(dispatch)).toEqual(['matrix:@+15550100001:other.example.org']);
  });
});

describe('welcome joins', () => {
  function load() {
    jest.resetModules();
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    const channel = { _cacheIncomingMedia: jest.fn(), sendMessage: jest.fn(async () => true), _resolveDmRoomId: jest.fn(async () => '!dm:localhost') };
    jest.doMock('../../bot/shared/services/messaging/matrix-channel.service', () => channel);
    const adapter = require('../../bot/shared/services/messaging/inbound/matrix-events.adapter');
    const client = {
      storageProvider: { readValue: jest.fn(async (k) => (k.includes('welcome-pending') ? FOREIGN_TEACHER : null)), storeValue: jest.fn() },
      getAccountData: jest.fn(async () => ({})),
      setAccountData: jest.fn(),
      getRoomStateEvent: jest.fn(async () => ({ membership: 'join' })),
    };
    return { adapter, channel, client };
  }
  const join = (userId) => ({ type: 'm.room.member', state_key: userId, content: { membership: 'join' } });

  it('a user from a server that is not allowed joining the welcome room gets no DM', async () => {
    const { adapter, channel, client } = load();
    await adapter.handleWelcomeRoomJoin(client, '!announce:localhost', '!announce:localhost', join(FOREIGN_TEACHER), OWN);
    expect(channel._resolveDmRoomId).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('...nor a greeting on joining a room marked as their pending welcome DM', async () => {
    const { adapter, channel, client } = load();
    await adapter.handleDmRoomJoin(client, '!dm:other.example.org', join(FOREIGN_TEACHER), OWN);
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('a user on the own server is still welcomed', async () => {
    const { adapter, channel, client } = load();
    await adapter.handleWelcomeRoomJoin(client, '!announce:localhost', '!announce:localhost', join(LOCAL_TEACHER), OWN);
    expect(channel.sendMessage).toHaveBeenCalledWith('mtx:15550100001', expect.any(String));
  });
});
