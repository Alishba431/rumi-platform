/**
 * Which recipients live on Meta. The Meta-only machinery (the 24-hour window,
 * templates, the window-closed cache) applies to a bare WhatsApp number on a
 * Meta deployment and to nothing else: a prefixed identity (mtx:, matrix:,
 * slack:, discord:) is sent to directly even when CHANNEL_DRIVER=meta, because
 * the additive channel is live alongside Meta.
 */

const { isMetaRecipient, displayIdentity } = require('../../bot/shared/services/observe/observe-channel');

describe('isMetaRecipient', () => {
  const META = { CHANNEL_DRIVER: 'meta' };
  const BAILEYS = { CHANNEL_DRIVER: 'baileys' };

  test.each([['15550100002'], ['+15550100002']])('bare number %s on Meta → true', (id) => {
    expect(isMetaRecipient(id, META)).toBe(true);
  });

  test.each([['mtx:15554000002'], ['matrix:@sam:example.org'], ['slack:U0123'], ['discord:9182']])(
    'prefixed %s on Meta → false', (id) => { expect(isMetaRecipient(id, META)).toBe(false); },
  );

  test('bare number off Meta → false; junk → false', () => {
    expect(isMetaRecipient('15550100002', BAILEYS)).toBe(false);
    expect(isMetaRecipient('12345', META)).toBe(false);
    expect(isMetaRecipient(null, META)).toBe(false);
  });
});

describe('displayIdentity', () => {
  test('digits show as +digits whatever the channel prefix; other ids as-is', () => {
    expect(displayIdentity('mtx:15550100002')).toBe('+15550100002');
    expect(displayIdentity('15550100003')).toBe('+15550100003');
    expect(displayIdentity('slack:U0123')).toBe('slack:U0123');
  });
});
