/**
 * The console's channel switches (RUMI_FEATURE_CHANNEL_<NAME>=off) must stop
 * the channel. They used to change only the console's own display: the bot
 * decides whether to connect Matrix/Discord, and the router whether to route
 * an additive channel at all, from resolveActiveChannels(env), which ignored
 * the switch. So "Teachers can no longer reach Rumi on your Matrix messenger"
 * was not true.
 *
 * messaging/index.js resolves the channels when it is first required, which in
 * whatsapp-bot.js is before the overrides cache is loaded, so the switch has to
 * be honoured from the env alone as well as from the cache.
 */

const MATRIX = { MATRIX_HOMESERVER_URL: 'https://matrix.example.org', MATRIX_ACCESS_TOKEN: 'test-token' };
const SLACK = { SLACK_BOT_TOKEN: 'x'.repeat(30), SLACK_SIGNING_SECRET: 'y'.repeat(30) };
const DISCORD = { DISCORD_BOT_TOKEN: 'x'.repeat(30), DISCORD_APPLICATION_ID: '1234567890' };

function freshAvailability() {
  jest.resetModules();
  return require('../../bot/shared/config/feature-availability');
}

afterEach(() => {
  jest.resetModules();
  for (const k of ['CHANNEL_DRIVER', ...Object.keys(MATRIX), 'RUMI_FEATURE_CHANNEL_MATRIX']) delete process.env[k];
});

describe('resolveActiveChannels honours the channel switch', () => {
  it('with MATRIX_* set and RUMI_FEATURE_CHANNEL_MATRIX=off, matrix is not active (cache never loaded)', () => {
    const fa = freshAvailability();
    expect(fa.resolveActiveChannels({ ...MATRIX })).toContain('matrix');
    expect(fa.resolveActiveChannels({ ...MATRIX, RUMI_FEATURE_CHANNEL_MATRIX: 'off' })).not.toContain('matrix');
  });

  it('and with the cache loaded the way whatsapp-bot.js loads it', () => {
    const fa = freshAvailability();
    const env = { ...MATRIX, RUMI_FEATURE_CHANNEL_MATRIX: 'off' };
    fa.overrides.load(env);
    expect(fa.resolveActiveChannels(env)).not.toContain('matrix');
    fa.overrides.load({});
  });

  it('applies to Slack and Discord too, and only to the channel switched off', () => {
    const fa = freshAvailability();
    const env = { ...MATRIX, ...SLACK, ...DISCORD, RUMI_FEATURE_CHANNEL_SLACK: 'off', RUMI_FEATURE_CHANNEL_DISCORD: 'OFF' };
    expect(fa.resolveActiveChannels(env)).toEqual(['matrix']);
  });

  it('the default stays on: an empty or any other value does not switch a channel off', () => {
    const fa = freshAvailability();
    expect(fa.resolveActiveChannels({ ...MATRIX, RUMI_FEATURE_CHANNEL_MATRIX: '' })).toContain('matrix');
    expect(fa.resolveActiveChannels({ ...MATRIX, RUMI_FEATURE_CHANNEL_MATRIX: 'on' })).toContain('matrix');
  });
});

describe('the router does not load or route a switched-off channel', () => {
  it('a matrix: identifier is never handed to the Matrix driver', async () => {
    jest.resetModules();
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    jest.doMock('../../bot/shared/storage/r2', () => ({ downloadFromR2: jest.fn(), extractKeyFromUrl: jest.fn() }));
    const matrixLoaded = jest.fn();
    jest.doMock('../../bot/shared/services/messaging/matrix-channel.service', () => {
      matrixLoaded();
      return { sendMessage: jest.fn().mockResolvedValue(true) };
    });
    Object.assign(process.env, MATRIX, { CHANNEL_DRIVER: 'baileys', RUMI_FEATURE_CHANNEL_MATRIX: 'off' });

    const idx = require('../../bot/shared/services/messaging');
    expect(matrixLoaded).not.toHaveBeenCalled();
    expect(() => idx.sendMessage('matrix:@teacher:example.org', 'hi')).toThrow(/matrix/);
  });
});

describe('a switched-off Slack ignores its webhooks', () => {
  it('acknowledges a signed event without dispatching it', async () => {
    jest.resetModules();
    jest.doMock('../../bot/shared/utils/logger', () => ({ logToFile: jest.fn() }));
    jest.doMock('../../bot/shared/config/supabase', () => ({ from: jest.fn() }));
    jest.doMock('../../bot/shared/services/slack-signature.service', () => ({ verify: () => true }));
    process.env.RUMI_FEATURE_CHANNEL_SLACK = 'off';
    try {
      const dispatch = jest.fn();
      const router = require('../../bot/shared/routes/slack-interactions.routes')(dispatch);
      const layer = router.stack.find((l) => l.route && l.route.path === '/events');
      const sent = [];
      const res = { status() { return res; }, send(b) { sent.push(b); return res; }, json(b) { sent.push(b); return res; } };
      const req = { rawBody: Buffer.from(JSON.stringify({ type: 'event_callback', event: { type: 'message', user: 'U1', text: 'hi' } })) };
      for (const handler of layer.route.stack) {
        let next = false;
        await handler.handle(req, res, () => { next = true; });
        if (!next) break;
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
    } finally {
      delete process.env.RUMI_FEATURE_CHANNEL_SLACK;
    }
  });
});
