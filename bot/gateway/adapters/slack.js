/**
 * bot/gateway/adapters/slack.js
 *
 * Slack Inbound Webhook Ingestion Gateway Adapter.
 * Decoupled from monolith under Strangler Fig migration.
 *
 * Responsibilities:
 * 1. Raw-body buffering via express.raw wildcard into req.rawBody.
 * 2. Cryptographic HMAC-SHA256 signature verification with constant-time equality
 *    and strict ±300s timestamp skew replay protection.
 * 3. Events API routing: url_verification challenge handshake and event_callback dispatch.
 * 4. Interactivity routing: Block Kit actions dispatch, modal view submissions/actions,
 *    and 400 Bad payload rejection for unparseable payloads.
 * 5. Slash commands routing: immediate 200 ack and plain text command dispatch.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const { logToFile } = require('../../shared/utils/logger');
const SlackSignatureService = require('../../shared/services/slack-signature.service');
const defaultModalInteractions = require('../../shared/routes/slack-modal-interactions.handler');
const defaultEventsAdapter = require('../../shared/services/messaging/inbound/slack-events.adapter');

const SIGNATURE_VERSION = 'v0';
const MAX_TIMESTAMP_SKEW_SECONDS = 300; // 5-minute replay-prevention window

/**
 * Dedicated raw-body capture middleware.
 * Ensures req.rawBody contains the unparsed Buffer of wire bytes
 * before any body parser reconstructs the payload.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function rawBodyMiddleware(req, res, next) {
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
    return next();
  }
  if (req.body && Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    return next();
  }
  if (req.rawBody != null && typeof req.rawBody === 'string') {
    req.rawBody = Buffer.from(req.rawBody, 'utf8');
    return next();
  }

  express.raw({ type: '*/*' })(req, res, (err) => {
    if (err) return next(err);
    if (req.body && Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
    }
    next();
  });
}

/**
 * Constant-time HMAC-SHA256 signature verification for Slack requests.
 *
 * @param {import('express').Request} req - Express request carrying headers and req.rawBody.
 * @param {string} [secret] - Optional signing secret override (defaults to process.env.SLACK_SIGNING_SECRET).
 * @returns {boolean} True if signature is valid and within timestamp window; false otherwise.
 */
function verifySlackSignature(req, secret) {
  const signingSecret = secret || process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return false;
  }

  const timestamp = req.headers ? req.headers['x-slack-request-timestamp'] : null;
  const signature = req.headers ? req.headers['x-slack-signature'] : null;

  if (!timestamp || !signature) {
    return false;
  }

  const numericTimestamp = Number(timestamp);
  if (isNaN(numericTimestamp) || !isFinite(numericTimestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - numericTimestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false;
  }

  const rawBody = req.rawBody != null
    ? (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : String(req.rawBody))
    : (req.body != null ? (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))) : '');

  const base = `${SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
  const expectedSignature = `${SIGNATURE_VERSION}=`
    + crypto.createHmac('sha256', signingSecret).update(base, 'utf8').digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  const signatureBuf = Buffer.from(String(signature), 'utf8');

  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

/**
 * Internal signature verifier delegating to SlackSignatureService if active/mocked,
 * with fallback to custom secret computation.
 *
 * @param {import('express').Request} req
 * @param {string} [secret]
 * @returns {boolean}
 */
function verifySignatureWithFallback(req, secret) {
  if (secret && secret !== process.env.SLACK_SIGNING_SECRET) {
    return verifySlackSignature(req, secret);
  }
  // Allows existing unit tests mocking SlackSignatureService to remain 100% effective
  if (typeof SlackSignatureService.verify === 'function') {
    return SlackSignatureService.verify(req);
  }
  return verifySlackSignature(req, secret);
}

/**
 * Middleware factory: verifies signature, then parses body into req.body.
 *
 * @param {'json'|'form'} contentType
 * @param {string} [secret]
 * @returns {import('express').RequestHandler}
 */
function verifyAndParse(contentType, secret) {
  return (req, res, next) => {
    if (!verifySignatureWithFallback(req, secret)) {
      logToFile('⚠️ Slack signature verification failed', { path: req.path });
      res.status(401).send('Invalid signature');
      return;
    }

    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    try {
      if (contentType === 'json') {
        req.body = raw ? JSON.parse(raw) : {};
      } else {
        const params = new URLSearchParams(raw);
        req.body = Object.fromEntries(params.entries());
      }
    } catch (error) {
      res.status(400).send('Bad request body');
      return;
    }
    next();
  };
}

/**
 * Creates the routed interactivity handler coordinating between modal dialogs
 * and standard Block Kit chat buttons.
 *
 * @param {Function} dispatch
 * @param {object} modalHandler
 * @param {object} eventsAdapter
 * @returns {Function}
 */
function makeRoutedInteractionsHandler(dispatch, modalHandler, eventsAdapter) {
  const chatHandler = eventsAdapter.makeInteractionsHandler(dispatch);

  return async function routeSlackInteraction(req, res) {
    let payload;
    try {
      payload = JSON.parse(req.body.payload);
    } catch (error) {
      res.status(400).send('Bad payload');
      return;
    }

    if (payload.type === 'view_submission') {
      try {
        const result = await modalHandler.handleViewSubmission(payload);
        if (result) {
          res.status(200).json(result);
        } else {
          res.status(200).send('');
        }
      } catch (error) {
        logToFile('❌ Slack interactions: view_submission dispatch failed', { error: error.message });
        res.status(200).send('');
      }
      return;
    }

    if (payload.type === 'block_actions') {
      const action = payload?.actions?.[0];
      if (
        modalHandler.isOpenModalAction(action?.action_id)
        || modalHandler.isBackAction(action?.action_id)
        || modalHandler.isAttendanceFinishAction(action?.action_id)
        || modalHandler.isCountryBucketAction(action?.action_id)
      ) {
        res.status(200).send(''); // ack immediately — modal update is a separate API call
        try {
          if (modalHandler.isOpenModalAction(action.action_id)) {
            await modalHandler.handleOpenModal(payload);
          } else if (modalHandler.isAttendanceFinishAction(action.action_id)) {
            await modalHandler.handleAttendanceFinish(payload);
          } else if (modalHandler.isCountryBucketAction(action.action_id)) {
            await modalHandler.handleCountryBucketChange(payload);
          } else {
            await modalHandler.handleBackButton(payload);
          }
        } catch (error) {
          logToFile('❌ Slack interactions: modal block_actions dispatch failed', { error: error.message });
        }
        return;
      }
    }

    // Standard chat interactivity fallback
    await chatHandler(req, res);
  };
}

/**
 * Primary factory function to create a configured Slack router.
 *
 * @param {object|Function} options - Options object or direct dispatch function for backward compatibility.
 * @param {Function} [options.dispatch] - Core multi-channel message dispatcher (e.g. handleWebhookPost).
 * @param {string} [options.signingSecret] - Optional Slack signing secret.
 * @param {object} [options.modalHandler] - Injected modal handler (defaults to slack-modal-interactions.handler).
 * @param {object} [options.eventsAdapter] - Injected events adapter (defaults to slack-events.adapter).
 * @returns {import('express').Router}
 */
function pausedChannel(req, res) {
  logToFile('Slack: channel switched off by the operator -- request ignored', { path: req.path });
  res.status(200).send('');
}

function createSlackRouter(options = {}) {
  const config = typeof options === 'function' ? { dispatch: options } : options;
  const {
    dispatch,
    signingSecret = process.env.SLACK_SIGNING_SECRET,
    modalHandler = defaultModalInteractions,
    eventsAdapter = defaultEventsAdapter,
  } = config;

  if (!dispatch || typeof dispatch !== 'function') {
    throw new TypeError('createSlackRouter requires a valid dispatch function');
  }

  const router = express.Router();

  // 1. Raw body buffering middleware mounted directly on router
  router.use(rawBodyMiddleware);

  // Operator switched Slack off (RUMI_FEATURE_CHANNEL_SLACK=off): acknowledge
  // (Slack retries anything else) and drop unread. Decided at mount, so it
  // applies at the next restart — same as slack-interactions.routes.js.
  const { isChannelSwitchedOff } = require('../../shared/config/feature-availability');
  if (isChannelSwitchedOff('slack', process.env)) {
    for (const path of ['/events', '/interactions', '/commands']) router.post(path, pausedChannel);
    return router;
  }

  // 2. Events API endpoint
  router.post('/events', verifyAndParse('json', signingSecret), eventsAdapter.makeEventsHandler(dispatch));

  // 3. Interactivity endpoint
  router.post('/interactions', verifyAndParse('form', signingSecret), makeRoutedInteractionsHandler(dispatch, modalHandler, eventsAdapter));

  // 4. Slash Commands endpoint
  router.post('/commands', verifyAndParse('form', signingSecret), eventsAdapter.makeSlashCommandHandler(dispatch));

  return router;
}

// Module export supporting both default call and destructuring
module.exports = createSlackRouter;
module.exports.createSlackRouter = createSlackRouter;
module.exports.verifySlackSignature = verifySlackSignature;
module.exports.rawBodyMiddleware = rawBodyMiddleware;
