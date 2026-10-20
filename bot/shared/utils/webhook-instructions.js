/**
 * The boot banner's "expose a public URL, then point Meta at it" steps.
 *
 * Only a Meta deployment has a Meta webhook to configure. These steps used to
 * print on every boot, so a CHANNEL_DRIVER=none deployment (no WhatsApp at
 * all) and a Baileys sandbox were told to paste a webhook into Meta, with
 * "Verify Token: undefined". Slack still needs a public URL for its Request
 * URLs, so a Slack deployment keeps the ngrok step without the Meta ones.
 *
 * Kept out of whatsapp-bot.js so it can be tested without booting the bot.
 *
 * @module shared/utils/webhook-instructions
 */

const { resolveChannelDriver, resolveActiveChannels } = require('../config/feature-availability');

const RULE = '='.repeat(70);

/**
 * @param {object} env
 * @param {{port: number|string, verifyToken?: string}} opts
 * @returns {string} the banner section, or '' when nothing needs a public URL
 */
function webhookInstructions(env, { port, verifyToken }) {
  const meta = resolveChannelDriver(env) === 'meta';
  const slack = resolveActiveChannels(env).includes('slack');
  if (!meta && !slack) return '';

  const ngrok = `${RULE}
📋 NEXT STEP: Start ngrok in a NEW terminal window
${RULE}

   Run this command in a new terminal:

   npx ngrok http ${port}${env.NGROK_AUTHTOKEN ? ` --authtoken ${env.NGROK_AUTHTOKEN}` : ''}
   ${env.NGROK_AUTHTOKEN ? '' : '(first time? add your own token from https://dashboard.ngrok.com → set NGROK_AUTHTOKEN in .env)'}

${RULE}
`;
  if (!meta) {
    return `${ngrok}
Then point your Slack app's Request URLs at the ngrok URL (see .env.template's Slack block).

${RULE}
`;
  }
  return `${ngrok}
Then copy the ngrok URL and configure it in Meta:
   1. Go to: https://developers.facebook.com/apps/
   2. Navigate to: WhatsApp → Configuration → Webhook
   3. Paste ngrok URL with /webhook (e.g., https://abc.ngrok-free.app/webhook)
   4. Verify Token: ${verifyToken}
   5. Subscribe to: messages
   6. Send a test message to your WhatsApp bot number

${RULE}
`;
}

module.exports = { webhookInstructions };
