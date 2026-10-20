/**
 * The boot banner's "configure it in Meta" steps. They used to print on every
 * boot, so a CHANNEL_DRIVER=none deployment (no WhatsApp at all) was told to
 * paste a webhook into Meta with "Verify Token: undefined".
 */

const { webhookInstructions } = require('../../bot/shared/utils/webhook-instructions');

const OPTS = { port: 3000, verifyToken: 'example-verify-token' };

describe('webhookInstructions', () => {
  it('prints the Meta webhook steps, with the verify token, when the driver is meta', () => {
    const text = webhookInstructions({ CHANNEL_DRIVER: 'meta' }, OPTS);
    expect(text).toMatch(/configure it in Meta/);
    expect(text).toMatch(/Verify Token: example-verify-token/);
    expect(text).toMatch(/ngrok http 3000/);
  });

  it.each(['none', 'baileys'])('prints no Meta steps when CHANNEL_DRIVER=%s', (driver) => {
    const text = webhookInstructions({ CHANNEL_DRIVER: driver }, { port: 3000, verifyToken: undefined });
    expect(text).not.toMatch(/Meta|Verify Token|undefined/);
  });

  it('still points a Slack deployment without Meta at ngrok, since Slack needs a public URL', () => {
    const env = { CHANNEL_DRIVER: 'none', SLACK_BOT_TOKEN: 'x'.repeat(30), SLACK_SIGNING_SECRET: 'y'.repeat(30) };
    const text = webhookInstructions(env, OPTS);
    expect(text).toMatch(/ngrok http 3000/);
    expect(text).not.toMatch(/Meta|Verify Token/);
  });
});
