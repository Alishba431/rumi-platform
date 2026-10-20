/**
 * matrix-identity.js -- the short ("mtx:<digits>" / "mtx:t<digits>") vs.
 * long ("matrix:@user:server") identity FORMAT codec. See that file's header
 * comment for:
 *  - the varchar(20) column budget this exists to respect (bug: lesson plan
 *    creation failing with "value too long for type character varying(20)"),
 *  - why a Matrix phone-number username is "+"+digits (canonical, Synapse
 *    accepts it, matches WhatsApp's own shape) or "t"+digits (fallback --
 *    Synapse rejects a purely numeric localpart outright), and
 *  - why the short form is only ever used for the bot's OWN homeserver, and
 *    keeps "+" and "t" accounts apart: an identity is a teacher, so it must
 *    name exactly one Matrix account.
 */

const OWN = '@rumi:localhost';

function loadIdentity() {
  jest.resetModules();
  // eslint-disable-next-line global-require
  return require('../../bot/shared/services/messaging/matrix-identity');
}

afterEach(() => {
  jest.resetModules();
});

describe('matrix-identity -- encodeIdentity', () => {
  it('encodes a "+"+digits (canonical phone-number) localpart on the own server to the short "mtx:<digits>" form, dropping the "+"', () => {
    const identity = loadIdentity();
    expect(identity.encodeIdentity('@+15550100001:localhost', OWN)).toBe('mtx:15550100001');
  });

  it('encodes a "t"+digits localpart on the own server to its OWN short form "mtx:t<digits>" -- a different account from "+<digits>"', () => {
    const identity = loadIdentity();
    expect(identity.encodeIdentity('@t15550100001:localhost', OWN)).toBe('mtx:t15550100001');
    expect(identity.encodeIdentity('@t15550100001:localhost', OWN))
      .not.toBe(identity.encodeIdentity('@+15550100001:localhost', OWN));
  });

  it('an account on another homeserver is never the same teacher: it keeps the long form, whatever its username', () => {
    const identity = loadIdentity();
    const logToFile = jest.fn();
    expect(identity.encodeIdentity('@+15550100001:other.example.org', OWN, { logToFile }))
      .toBe('matrix:@+15550100001:other.example.org');
    expect(identity.encodeIdentity('@t15550100001:other.example.org', OWN, { logToFile }))
      .toBe('matrix:@t15550100001:other.example.org');
  });

  it('a homeserver that only shares a prefix with the own one, or adds a port, is another server', () => {
    const identity = loadIdentity();
    const logToFile = jest.fn();
    expect(identity.encodeIdentity('@+15550100001:localhost.example.org', OWN, { logToFile }))
      .toBe('matrix:@+15550100001:localhost.example.org');
    expect(identity.encodeIdentity('@+15550100001:localhost:8448', OWN, { logToFile }))
      .toBe('matrix:@+15550100001:localhost:8448');
  });

  it('never emits the short form when the own server is unknown', () => {
    const identity = loadIdentity();
    const logToFile = jest.fn();
    expect(identity.encodeIdentity('@+15550100001:localhost', null, { logToFile })).toBe('matrix:@+15550100001:localhost');
    expect(identity.encodeIdentity('@+15550100001:localhost', undefined, { logToFile })).toBe('matrix:@+15550100001:localhost');
  });

  it('an uppercase "T" is not the "t" form (it could not decode back to the same account) -- long form', () => {
    const identity = loadIdentity();
    expect(identity.encodeIdentity('@T15550100001:localhost', OWN, { logToFile: jest.fn() })).toBe('matrix:@T15550100001:localhost');
  });

  it('the short forms are <= 20 characters for the longest possible localpart ("+"/"t" + 15 digits)', () => {
    const identity = loadIdentity();
    const fifteenDigits = '155501000012345';
    const plus = identity.encodeIdentity(`@+${fifteenDigits}:localhost`, OWN);
    const t = identity.encodeIdentity(`@t${fifteenDigits}:localhost`, OWN);
    expect(plus).toBe(`mtx:${fifteenDigits}`);
    expect(plus.length).toBe(19); // "mtx:" (4) + 15 digits
    expect(t).toBe(`mtx:t${fifteenDigits}`);
    expect(t.length).toBe(20); // "mtx:t" (5) + 15 digits
  });

  it('rejects a PURELY numeric localpart (no leading "+"/"t") as a phone-number form -- Synapse itself would reject that account', () => {
    const identity = loadIdentity();
    const logToFile = jest.fn();
    // Falls through to the long form, exactly like any other non-matching localpart.
    expect(identity.encodeIdentity('@15550100001:localhost', OWN, { logToFile })).toBe('matrix:@15550100001:localhost');
  });

  it('rejects fewer than 7 digits or more than 15 digits after the "+"/"t"', () => {
    const identity = loadIdentity();
    const logToFile = jest.fn();
    expect(identity.encodeIdentity('@+123456:localhost', OWN, { logToFile })).toBe('matrix:@+123456:localhost'); // 6 digits
    expect(identity.encodeIdentity('@+1234567890123456:localhost', OWN, { logToFile })).toBe('matrix:@+1234567890123456:localhost'); // 16 digits
  });

  it('falls back to the existing long form for a non-phone-shaped localpart, and does not crash', () => {
    const identity = loadIdentity();
    const logToFile = jest.fn();
    expect(identity.encodeIdentity('@teacher:localhost', OWN, { logToFile })).toBe('matrix:@teacher:localhost');
    expect(identity.encodeIdentity('@teacher576594:localhost', OWN, { logToFile })).toBe('matrix:@teacher576594:localhost');
  });

  it('logs the non-phone-username warning exactly once per process, at info level, mentioning the 20-character limit', () => {
    const identity = loadIdentity();
    const logToFile = jest.fn();
    identity.encodeIdentity('@teacher:localhost', OWN, { logToFile });
    identity.encodeIdentity('@someone-else:localhost', OWN, { logToFile });
    expect(logToFile).toHaveBeenCalledTimes(1);
    expect(logToFile.mock.calls[0][0]).toMatch(/20-character/);
    expect(logToFile.mock.calls[0][0]).toMatch(/phone number/);
  });

  it('never truncates a long identity to fit -- returns it whole even though it may overflow the DB column', () => {
    const identity = loadIdentity();
    const longId = '@a-very-long-admin-account-name:example.org';
    expect(identity.encodeIdentity(longId, '@rumi:example.org', { logToFile: jest.fn() })).toBe(`matrix:${longId}`);
  });
});

describe('matrix-identity -- decodeIdentity', () => {
  it('decodes "mtx:<digits>" to the "+<digits>" account on the own server', () => {
    const identity = loadIdentity();
    expect(identity.decodeIdentity('mtx:15550100001', OWN)).toBe('@+15550100001:localhost');
  });

  it('decodes "mtx:t<digits>" to the "t<digits>" account on the own server', () => {
    const identity = loadIdentity();
    expect(identity.decodeIdentity('mtx:t15550100001', OWN)).toBe('@t15550100001:localhost');
  });

  it('keeps a port in the own server name', () => {
    const identity = loadIdentity();
    expect(identity.decodeIdentity('mtx:15550100001', '@rumi:localhost:8448')).toBe('@+15550100001:localhost:8448');
  });

  it('refuses a short identity that is not one of the two phone forms -- never builds a user id out of it', () => {
    const identity = loadIdentity();
    expect(() => identity.decodeIdentity('mtx:teacher', OWN)).toThrow(/not a short Matrix identity/);
    expect(() => identity.decodeIdentity('mtx:15550100001:other.example.org', OWN)).toThrow(/not a short Matrix identity/);
  });

  it('decodes a long "matrix:<user_id>" identity by stripping the prefix, unaffected by any embedded colon', () => {
    const identity = loadIdentity();
    expect(identity.decodeIdentity('matrix:@teacher:example.org', '@rumi:example.org')).toBe('@teacher:example.org');
  });

  it('passes through an already-bare user id unchanged', () => {
    const identity = loadIdentity();
    expect(identity.decodeIdentity('@teacher:example.org', null)).toBe('@teacher:example.org');
  });

  it('throws a clear error decoding a short identity when the own server name is unknown -- never silently mis-routes', () => {
    const identity = loadIdentity();
    expect(() => identity.decodeIdentity('mtx:15550100001', null)).toThrow(/server name is unknown/);
    expect(() => identity.decodeIdentity('mtx:15550100001', undefined)).toThrow(/server name is unknown/);
  });
});

describe('matrix-identity -- round trip', () => {
  it.each([
    '@+15550100001:localhost',
    '@t15550100001:localhost',
    '@teacher:localhost',
    '@+15550100001:other.example.org',
    '@t15550100001:other.example.org',
  ])('%s round-trips to exactly the same account', (fullUserId) => {
    const identity = loadIdentity();
    const wire = identity.encodeIdentity(fullUserId, OWN, { logToFile: jest.fn() });
    expect(identity.decodeIdentity(wire, OWN)).toBe(fullUserId);
  });
});

describe('matrix-identity -- server helpers', () => {
  it('splitUserId separates localpart and server (port included), or returns null for a malformed id', () => {
    const identity = loadIdentity();
    expect(identity.splitUserId('@+15550100001:localhost')).toEqual({ localpart: '+15550100001', server: 'localhost' });
    expect(identity.splitUserId('@rumi:localhost:8448')).toEqual({ localpart: 'rumi', server: 'localhost:8448' });
    expect(identity.splitUserId('not-a-user-id')).toBeNull();
  });

  it('allowedServers is the own server alone by default, plus MATRIX_ALLOWED_SERVERS when set', () => {
    const identity = loadIdentity();
    expect([...identity.allowedServers(OWN, {})]).toEqual(['localhost']);
    expect([...identity.allowedServers(OWN, { MATRIX_ALLOWED_SERVERS: ' ' })]).toEqual(['localhost']);
    expect([...identity.allowedServers(OWN, { MATRIX_ALLOWED_SERVERS: 'localhost, other.example.org,' })].sort())
      .toEqual(['localhost', 'other.example.org']);
    expect([...identity.allowedServers(null, {})]).toEqual([]);
  });

  it('isAllowedSender checks the sender\'s server exactly, port included', () => {
    const identity = loadIdentity();
    const env = { MATRIX_ALLOWED_SERVERS: 'other.example.org' };
    expect(identity.isAllowedSender('@+15550100001:localhost', OWN, {})).toBe(true);
    expect(identity.isAllowedSender('@+15550100001:other.example.org', OWN, {})).toBe(false);
    expect(identity.isAllowedSender('@+15550100001:other.example.org', OWN, env)).toBe(true);
    expect(identity.isAllowedSender('@+15550100001:localhost', OWN, env)).toBe(true); // the own server is always allowed
    expect(identity.isAllowedSender('@+15550100001:localhost:8448', OWN, {})).toBe(false);
    expect(identity.isAllowedSender('not-a-user-id', OWN, {})).toBe(false);
    expect(identity.isAllowedSender('@+15550100001:localhost', null, {})).toBe(false);
  });
});
