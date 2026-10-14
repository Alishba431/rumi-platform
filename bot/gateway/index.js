/**
 * bot/gateway/index.js
 *
 * Webhook Ingestion Gateway Hub (Strangler Fig Architecture).
 *
 * Orchestrates platform-specific ingress adapters (WhatsApp, Slack) and
 * provides a unified integration bridge into Express applications.
 *
 * Responsibilities:
 * 1. Router composition: combines WhatsApp and Slack adapters into a coherent gateway.
 * 2. Setup helper: provides setupGateway(app, options) to mount adapters with
 *    strict middleware ordering preservation.
 * 3. Factory function: provides createGatewayRouter(options) and createGateway(options).
 * 4. Backward compatibility: preserves 100% feature parity with legacy monolith
 *    and multi-channel dispatcher (handleWebhookPost).
 */

'use strict';

const express = require('express');
const { createWhatsAppRouter, verifyWhatsAppSignature } = require('./adapters/whatsapp');
const { createSlackRouter, verifySlackSignature, rawBodyMiddleware } = require('./adapters/slack');

/**
 * Creates a combined gateway router composing both WhatsApp and Slack adapters.
 *
 * NOTE: If mounting this composite router directly into an Express app, ensure
 * it is mounted BEFORE global express.json(), because Slack subroutes require
 * raw-body capture before JSON parsing.
 *
 * @param {Object} options
 * @param {Function} options.dispatch - Central message dispatcher (handleWebhookPost)
 * @param {string} [options.verifyToken] - Meta verify token for WhatsApp handshake
 * @param {string} [options.appSecret] - Meta app secret for optional WhatsApp HMAC
 * @param {string} [options.signingSecret] - Slack signing secret for HMAC verification
 * @param {Object} [options.whatsappConfig] - Specific config forwarded to WhatsApp adapter
 * @param {Object} [options.slackConfig] - Specific config forwarded to Slack adapter
 * @returns {import('express').Router}
 */
function createGatewayRouter(options = {}) {
  const router = express.Router();
  const dispatch = options.dispatch;

  const whatsappOpts = {
    dispatch,
    verifyToken: options.verifyToken,
    appSecret: options.appSecret,
    ...(options.whatsappConfig || {}),
  };

  const slackOpts = {
    dispatch,
    signingSecret: options.signingSecret,
    ...(options.slackConfig || {}),
  };

  const whatsAppRouter = createWhatsAppRouter(whatsappOpts);
  const slackRouter = createSlackRouter(slackOpts);

  // Mount platform adapters as sub-routers
  router.use('/webhook', whatsAppRouter);
  router.use('/api/slack', slackRouter);

  return router;
}

/**
 * Convenience factory returning the composite router and individual adapter routers.
 *
 * @param {Object} options
 * @returns {{ router: import('express').Router, whatsAppRouter: import('express').Router, slackRouter: import('express').Router }}
 */
function createGateway(options = {}) {
  const dispatch = options.dispatch;

  const whatsappOpts = {
    dispatch,
    verifyToken: options.verifyToken,
    appSecret: options.appSecret,
    ...(options.whatsappConfig || {}),
  };

  const slackOpts = {
    dispatch,
    signingSecret: options.signingSecret,
    ...(options.slackConfig || {}),
  };

  const whatsAppRouter = createWhatsAppRouter(whatsappOpts);
  const slackRouter = createSlackRouter(slackOpts);
  const router = createGatewayRouter(options);

  return {
    router,
    whatsAppRouter,
    slackRouter,
  };
}

/**
 * Plugs the gateway into an existing Express application.
 *
 * Mounts:
 * 1. Slack adapter at /api/slack (encapsulating raw-body capture & HMAC check)
 * 2. WhatsApp adapter at /webhook (handling GET handshake and POST ingestion)
 *
 * Middleware ordering discipline:
 * - Call this helper BEFORE mounting global app.use(express.json()) to ensure
 *   Slack raw-body capture occurs prior to any JSON stream parsing.
 *
 * @param {import('express').Application} app - Target Express application instance
 * @param {Object} options
 * @param {Function} options.dispatch - Central dispatcher (handleWebhookPost)
 * @param {string} [options.verifyToken] - Meta verify token
 * @param {string} [options.appSecret] - Meta app secret
 * @param {string} [options.signingSecret] - Slack signing secret
 * @param {Object} [options.whatsappConfig] - WhatsApp specific options
 * @param {Object} [options.slackConfig] - Slack specific options
 * @returns {{ whatsAppRouter: import('express').Router, slackRouter: import('express').Router }}
 */
function setupGateway(app, options = {}) {
  if (!app || typeof app.use !== 'function') {
    throw new TypeError('setupGateway requires a valid Express application instance');
  }

  const {
    dispatch,
    verifyToken,
    appSecret,
    signingSecret,
    whatsappConfig = {},
    slackConfig = {},
  } = options;

  const slackRouter = createSlackRouter({
    dispatch,
    signingSecret: signingSecret || process.env.SLACK_SIGNING_SECRET,
    ...slackConfig,
  });

  const whatsAppRouter = createWhatsAppRouter({
    dispatch,
    verifyToken: verifyToken || process.env.WEBHOOK_VERIFY_TOKEN,
    appSecret: appSecret || process.env['APP_SECRET'] || process.env['WHATSAPP_APP_SECRET'],
    ...whatsappConfig,
  });

  // Mount Slack first: captures raw bytes for HMAC before JSON parsing
  app.use('/api/slack', slackRouter);

  // Mount WhatsApp router at /webhook
  app.use('/webhook', whatsAppRouter);

  return { slackRouter, whatsAppRouter };
}

module.exports = {
  createGateway,
  createGatewayRouter,
  setupGateway,
  createWhatsAppRouter,
  createSlackRouter,
  verifyWhatsAppSignature,
  verifySlackSignature,
  rawBodyMiddleware,
};
