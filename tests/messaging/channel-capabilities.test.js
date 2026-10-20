/**
 * channel-capabilities — which channel can draw a native WhatsApp Flow.
 *
 * Several handlers decide "open the Flow" only by checking that a *_FLOW_ID
 * env var is set. On a deployment that runs Meta AND Matrix (the expected
 * migration path) those ids are set for Meta, and a Matrix or Baileys teacher
 * used to hit a dead end: sendFlow() returns false there and nothing else was
 * said. Gates ask this module instead, so a channel without native Flows
 * takes the same text path a deployment with no Flow id takes.
 */

const caps = require('../../bot/shared/services/messaging/channel-capabilities');

const META_ENV = { CHANNEL_DRIVER: 'meta' };
const BAILEYS_ENV = { CHANNEL_DRIVER: 'baileys' };

describe('flowSurfaceFor', () => {
  it('is "native" for a WhatsApp number on the Meta driver', () => {
    expect(caps.flowSurfaceFor('15550100001', META_ENV)).toBe('native');
  });

  it('is "native" when the Meta driver is inferred from its credentials', () => {
    expect(caps.flowSurfaceFor('15550100001', { WHATSAPP_TOKEN: 'x' })).toBe('native');
  });

  it('is "text" for a WhatsApp number on Baileys', () => {
    expect(caps.flowSurfaceFor('15550100001', BAILEYS_ENV)).toBe('text');
  });

  it('is "text" for Matrix, in both identity forms, whatever the WhatsApp driver', () => {
    expect(caps.flowSurfaceFor('mtx:15550100001', META_ENV)).toBe('text');
    expect(caps.flowSurfaceFor('matrix:@teacher:example.org', META_ENV)).toBe('text');
  });

  it('is "modal" for Slack and Discord, which draw some Flows as modals', () => {
    expect(caps.flowSurfaceFor('slack:U0123ABC', META_ENV)).toBe('modal');
    expect(caps.flowSurfaceFor('discord:918273645', META_ENV)).toBe('modal');
  });
});

describe('nativeFlowIdFor', () => {
  it('passes the Flow id through only where a native Flow can render', () => {
    expect(caps.nativeFlowIdFor('15550100001', 'flow_1', META_ENV)).toBe('flow_1');
    expect(caps.nativeFlowIdFor('15550100001', 'flow_1', BAILEYS_ENV)).toBe('');
    expect(caps.nativeFlowIdFor('mtx:15550100001', 'flow_1', META_ENV)).toBe('');
    expect(caps.nativeFlowIdFor('slack:U0123ABC', 'flow_1', META_ENV)).toBe('');
  });

  it('is empty when no Flow id is configured', () => {
    expect(caps.nativeFlowIdFor('15550100001', undefined, META_ENV)).toBe('');
    expect(caps.nativeFlowIdFor('15550100001', '', META_ENV)).toBe('');
  });
});
