/**
 * channel-registry — pure data, no env/process logic. Confirms the shape the
 * rest of the messaging module (and feature-availability.js) builds on: a
 * default-sandbox rule with an explicit production allowlist, not a per-driver
 * tag someone has to remember to set. Also confirms the additive-channel
 * concept (Slack, Discord, ...) — drivers that run ALONGSIDE the one
 * WhatsApp-family driver (meta|baileys) via their own env-var presence,
 * never selected through CHANNEL_DRIVER, each carrying a wire prefix so
 * messaging/index.js's router can dispatch to them by identifier shape.
 */

const registry = require('../../bot/shared/services/messaging/channel-registry');

describe('channel-registry', () => {
  it('lists meta and baileys as the WhatsApp-family drivers, defaulting to baileys', () => {
    expect(Object.keys(registry.DRIVERS)).toEqual(expect.arrayContaining(['baileys', 'meta']));
    expect(registry.DEFAULT_DRIVER).toBe('baileys');
  });

  it('lists slack, discord, and matrix as additive channel drivers, alongside the WhatsApp-family ones', () => {
    expect(registry.DRIVERS.slack).toBe('./slack-channel.service');
    expect(registry.DRIVERS.discord).toBe('./discord-channel.service');
    expect(registry.DRIVERS.matrix).toBe('./matrix-channel.service');
  });

  it('meta, slack, discord, and matrix are the production-tier drivers, baileys is sandbox only', () => {
    expect(registry.PRODUCTION_TIER_DRIVERS.sort()).toEqual(['discord', 'matrix', 'meta', 'slack']);
    expect(registry.isProductionTier('meta')).toBe(true);
    expect(registry.isProductionTier('slack')).toBe(true);
    expect(registry.isProductionTier('discord')).toBe(true);
    expect(registry.isProductionTier('matrix')).toBe(true);
    expect(registry.isProductionTier('baileys')).toBe(false);
    // A hypothetical future driver not yet on the allowlist is sandbox by default.
    expect(registry.isProductionTier('telegram')).toBe(false);
  });

  it('isKnownDriver reflects exactly the DRIVERS map', () => {
    expect(registry.isKnownDriver('meta')).toBe(true);
    expect(registry.isKnownDriver('baileys')).toBe(true);
    expect(registry.isKnownDriver('slack')).toBe(true);
    expect(registry.isKnownDriver('discord')).toBe(true);
    expect(registry.isKnownDriver('matrix')).toBe(true);
    expect(registry.isKnownDriver('telegram')).toBe(false);
  });

  it('slack/discord/matrix carry their own wire prefix; WhatsApp-family drivers carry none', () => {
    expect(registry.prefixFor('slack')).toBe('slack');
    expect(registry.prefixFor('discord')).toBe('discord');
    expect(registry.prefixFor('matrix')).toBe('matrix');
    expect(registry.prefixFor('meta')).toBeNull();
    expect(registry.prefixFor('baileys')).toBeNull();
  });

  it('driverForIdentifier resolves a prefixed identifier to its driver, and a bare phone number to null', () => {
    expect(registry.driverForIdentifier('slack:U0123ABC')).toBe('slack');
    expect(registry.driverForIdentifier('discord:918273645')).toBe('discord');
    expect(registry.driverForIdentifier('15550101234')).toBeNull();
  });

  it('driverForIdentifier resolves a Matrix identifier correctly even though the Matrix user id itself contains a colon', () => {
    // "matrix:@teacher:example.org" -- splitting on the FIRST colon must yield
    // prefix "matrix" and leave "@teacher:example.org" (still containing its
    // own colon) untouched as the id.
    expect(registry.driverForIdentifier('matrix:@teacher:example.org')).toBe('matrix');
  });

  it('driverForIdentifier also routes the short Matrix "mtx:" identity (phone-number localpart) to matrix', () => {
    // See matrix-identity.js's header comment: "mtx:" is the short wire form
    // for a numeric Matrix localpart, kept out of CHANNEL_PREFIXES/prefixFor
    // so it doesn't disturb the canonical 'matrix' prefix the tests above rely on.
    expect(registry.driverForIdentifier('mtx:15550101234')).toBe('matrix');
  });

  it('prefixFor("matrix") is unaffected by the "mtx:" alias -- stays the canonical long-form prefix', () => {
    expect(registry.prefixFor('matrix')).toBe('matrix');
  });

  it('the "mtx:" alias does not steal slack or discord identifiers', () => {
    expect(registry.driverForIdentifier('slack:mtx-not-a-real-user')).toBe('slack');
    expect(registry.driverForIdentifier('discord:mtx12345')).toBe('discord');
  });

  describe('resolveChannelIdentity', () => {
    it('is null for a bare WhatsApp phone number', () => {
      expect(registry.resolveChannelIdentity('15550100001')).toBeNull();
    });

    it('strips exactly the canonical prefix, keeping a Matrix id\'s own colon', () => {
      expect(registry.resolveChannelIdentity('slack:U0123ABC')).toEqual({ channel: 'slack', channelUserId: 'U0123ABC' });
      expect(registry.resolveChannelIdentity('matrix:@teacher:example.org'))
        .toEqual({ channel: 'matrix', channelUserId: '@teacher:example.org' });
    });

    it('strips an alias prefix (mtx:) by its own length, not the driver name\'s', () => {
      // "mtx:" is 4 characters, "matrix:" is 7: slicing by the driver name
      // would drop the first 3 digits of the phone number.
      expect(registry.resolveChannelIdentity('mtx:15550100001'))
        .toEqual({ channel: 'matrix', channelUserId: '15550100001' });
    });

    it('keeps two numbers that differ only in their first digits as two identities', () => {
      const a = registry.resolveChannelIdentity('mtx:15550107777');
      const b = registry.resolveChannelIdentity('mtx:25550107777');
      expect(a.channelUserId).not.toBe(b.channelUserId);
    });
  });
});
