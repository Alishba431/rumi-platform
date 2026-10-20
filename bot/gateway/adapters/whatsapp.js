/**
 * bot/gateway/adapters/whatsapp.js
 *
 * WhatsApp Webhook Ingress Gateway Adapter.
 * Encapsulates Meta WhatsApp Business Cloud API ingress:
 * - GET /webhook: Meta hub verification handshake
 * - POST /webhook: Optional HMAC verification, safe navigation, status receipts,
 *                  message validation, deduplication, reactions, typing indicator,
 *                  and downstream dispatch to handleWebhookPost.
 *
 * Part of the Strangler Fig migration decoupling ingress from bot/whatsapp-bot.js.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');

// Internal project dependencies
const SessionService = require('../../shared/services/session.service');
const WhatsAppService = require('../../shared/services/whatsapp.service');
const validators = require('../../shared/utils/validators');
const constants = require('../../shared/utils/constants');
const { logToFile } = require('../../shared/utils/logger');
const { generateCorrelationId, runWithCorrelation } = require('../../shared/utils/structured-logger');

/**
 * Verify Meta HMAC-SHA256 signature (x-hub-signature-256)
 *
 * @param {express.Request} req - Inbound Express request
 * @param {string} appSecret - Meta App Secret
 * @returns {boolean} True if signature is valid or appSecret not provided; false otherwise
 */
function verifyWhatsAppSignature(req, appSecret) {
  if (!appSecret) {
    return true; // Bypass signature check when secret is not configured
  }

  const signatureHeader = req.headers?.['x-hub-signature-256'];
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  const [scheme, signature] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !signature) {
    return false;
  }

  // Obtain raw body bytes
  let rawBodyBuffer;
  if (Buffer.isBuffer(req.rawBody)) {
    rawBodyBuffer = req.rawBody;
  } else if (Buffer.isBuffer(req.body)) {
    rawBodyBuffer = req.body;
  } else if (typeof req.rawBody === 'string') {
    rawBodyBuffer = Buffer.from(req.rawBody, 'utf8');
  } else if (typeof req.body === 'string') {
    rawBodyBuffer = Buffer.from(req.body, 'utf8');
  } else if (req.body && typeof req.body === 'object') {
    rawBodyBuffer = Buffer.from(JSON.stringify(req.body), 'utf8');
  } else {
    rawBodyBuffer = Buffer.from('', 'utf8');
  }

  const expectedSignature = crypto
    .createHmac('sha256', appSecret)
    .update(rawBodyBuffer)
    .digest('hex');

  try {
    const signatureBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length || signatureBuffer.length === 0) {
      return false;
    }

    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (err) {
    return false;
  }
}

/**
 * Factory function creating the WhatsApp Express Router
 *
 * @param {Object} options - Configuration options
 * @param {Function} options.dispatch - Downstream dispatcher (handleWebhookPost)
 * @param {string} [options.verifyToken] - Verification token for GET /webhook handshake
 * @param {string} [options.appSecret] - Meta App Secret for HMAC verification
 * @param {Function} [options.handleBroadcastStatus] - Optional broadcast status handler
 * @param {Object} [options.sessionService] - SessionService instance
 * @param {Object} [options.whatsAppService] - WhatsAppService instance
 * @param {Object} [options.validators] - Validators utility
 * @param {boolean} [options.encapsulateIngress=true] - Whether to execute duplicate checking & reactions
 * @returns {express.Router}
 */
function createWhatsAppRouter(options = {}) {
  const {
    dispatch,
    verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || constants.WEBHOOK_VERIFY_TOKEN,
    appSecret = options.appSecret || process.env['APP_SECRET'] || process.env['WHATSAPP_APP_SECRET'],
    handleBroadcastStatus = null,
    sessionService = SessionService,
    whatsAppService = WhatsAppService,
    validatorsUtil = validators,
    encapsulateIngress = true,
  } = options;

  if (typeof dispatch !== 'function') {
    throw new TypeError('createWhatsAppRouter requires a valid dispatch function');
  }

  const router = express.Router();

  // Ensure JSON parsing middleware is present if not already run globally
  router.use(express.json());

  /**
   * GET /webhook Verification Handshake Handler
   */
  async function handleVerification(req, res) {
    const mode = req.query?.['hub.mode'];
    const token = req.query?.['hub.verify_token'];
    const challenge = req.query?.['hub.challenge'];

    console.log('Webhook verification request received');
    console.log('Mode:', mode);
    console.log('Token:', token);

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      console.log('Webhook verified successfully!');
      logToFile('✅ Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.log('Webhook verification failed');
      logToFile('⚠️ Webhook verification failed', { mode, tokenProvided: !!token });
      res.status(403).send('Forbidden');
    }
  }

  /**
   * POST /webhook Ingress Handler
   */
  async function handleIncoming(req, res) {
    // 1. Optional HMAC signature verification
    if (appSecret && !verifyWhatsAppSignature(req, appSecret)) {
      logToFile('⚠️ Webhook signature verification failed');
      res.status(401).send('Invalid signature');
      return;
    }

    // 2. Safe navigation on body: immediately acknowledge non-JSON or empty bodies
    if (!req.body || typeof req.body !== 'object' || !Array.isArray(req.body.entry) || req.body.entry.length === 0) {
      if (!res.headersSent) {
        res.status(200).send('EVENT_RECEIVED');
      }
      return;
    }

    // 3. Correlation context wrapping
    const correlationId = generateCorrelationId();
    await runWithCorrelation(correlationId, async () => {
      logToFile('=== INCOMING WEBHOOK ===', { correlationId });

      // Diagnostic logging with safe optional chaining
      const webhookValue = req.body?.entry?.[0]?.changes?.[0]?.value;
      logToFile('Webhook diagnostic', {
        correlationId,
        hasMessages: !!webhookValue?.messages,
        hasStatuses: !!webhookValue?.statuses,
        messageType: webhookValue?.messages?.[0]?.type,
        buttonPayload: webhookValue?.messages?.[0]?.button?.payload,
        interactiveType: webhookValue?.messages?.[0]?.interactive?.type,
        interactiveId: webhookValue?.messages?.[0]?.interactive?.list_reply?.id ||
                       webhookValue?.messages?.[0]?.interactive?.button_reply?.id,
      });

      try {
        // 4. Intercept delivery/read status webhooks (broadcast tracking)
        const statusValidation = validatorsUtil.validateWebhookStatus(req);
        if (statusValidation) {
          if (typeof handleBroadcastStatus === 'function') {
            await handleBroadcastStatus(statusValidation.statuses);
          } else {
            // Forward to downstream dispatcher for status handling if supported
            await dispatch(req, res);
          }
          if (!res.headersSent) {
            res.status(200).send('EVENT_RECEIVED');
          }
          return;
        }

        // 5. Validate webhook message envelope structure
        const validation = validatorsUtil.validateWebhookMessage(req);
        if (!validation) {
          if (!res.headersSent) {
            res.status(200).send('EVENT_RECEIVED');
          }
          return;
        }

        const { entry, message, from, messageType, messageTimestamp, phoneNumberId } = validation;

        // Skip webhooks for other phone numbers (cross-WABA prevention)
        if (!validatorsUtil.isOurPhoneNumber(phoneNumberId)) {
          if (!res.headersSent) {
            res.status(200).send('EVENT_RECEIVED');
          }
          return;
        }

        // Skip test webhooks
        if (validatorsUtil.isTestWebhook(entry)) {
          if (!res.headersSent) {
            res.status(200).send('EVENT_RECEIVED');
          }
          return;
        }

        logToFile(`Message received from ${from}`, {
          messageType,
          messageId: message.id,
          timestamp: messageTimestamp,
          hasText: !!message.text,
          hasAudio: !!message.audio,
          hasVoice: !!message.voice,
          fullMessage: message,
        });

        // Skip test phone numbers
        if (validatorsUtil.isTestPhoneNumber(from)) {
          if (!res.headersSent) {
            res.status(200).send('EVENT_RECEIVED');
          }
          return;
        }

        // Check message timestamp window (24-hour limit)
        if (!validatorsUtil.isWithin24Hours(messageTimestamp, from)) {
          if (!res.headersSent) {
            res.status(200).send('EVENT_RECEIVED');
          }
          return;
        }

        // 6. Ingress deduplication & side-effects (if encapsulateIngress is enabled)
        if (encapsulateIngress) {
          // Redis-backed duplicate detection
          const alreadyProcessed = await sessionService.isProcessed(message.id);
          if (alreadyProcessed) {
            logToFile('⚠️ Duplicate message detected and skipped', {
              messageId: message.id,
              from,
              timestamp: messageTimestamp,
            });
            if (!res.headersSent) {
              res.status(200).send('EVENT_RECEIVED');
            }
            return;
          }

          // Mark message as processed
          await sessionService.markAsProcessed(message.id);

          logToFile('✅ Message accepted for processing', {
            messageId: message.id,
            from,
            type: messageType,
          });

          // Trigger reaction emoji based on user first-message state
          const emoji = sessionService.getReactionEmoji(from);
          await whatsAppService.sendReaction(from, message.id, emoji);

          // Show typing indicator
          await whatsAppService.showTypingIndicator(from, message.id);

          // Tag request to inform downstream dispatcher that ingress side-effects are complete
          req._gatewayHandled = true;
          req._deduplicated = true;
          req._reacted = true;
        }

        // 7. Dispatch to central multi-channel dispatcher (handleWebhookPost)
        await dispatch(req, res);

        // 8. Guarantee HTTP 200 acknowledgement to Meta
        if (!res.headersSent) {
          res.status(200).send('EVENT_RECEIVED');
        }
      } catch (error) {
        logToFile('❌ Error processing webhook in WhatsApp adapter', {
          error: error.message,
          stack: error.stack,
        });
        if (!res.headersSent) {
          res.status(200).send('EVENT_RECEIVED');
        }
      }
    });
  }

  // Dual mount routing: supports both app.use('/webhook', router) and app.use(router)
  const webhookPaths = ['/', '/webhook'];

  router.get(webhookPaths, (req, res, next) => {
    // If mounted at application root ('') and path is strictly '/', pass through to root health check
    if (req.baseUrl === '' && req.path === '/') {
      return next();
    }
    return handleVerification(req, res);
  });

  router.post(webhookPaths, (req, res, next) => {
    // If mounted at application root ('') and path is strictly '/', pass through
    if (req.baseUrl === '' && req.path === '/') {
      return next();
    }
    return handleIncoming(req, res);
  });

  return router;
}

module.exports = {
  createWhatsAppRouter,
  verifyWhatsAppSignature,
};
