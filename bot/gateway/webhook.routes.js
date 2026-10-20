/**
 * Webhook Ingestion Gateway — queue mode (Phase 2) and standalone server (Phase 3)
 *
 * Built on the in-process WhatsApp gateway router (adapters/whatsapp.js), which
 * keeps doing the Meta handshake, signature check and envelope validation. In
 * queue mode its dispatch step turns the request into an InboundMessageEnvelope
 * and hands it to an IngressDispatcher, which queues it; the router then acks
 * Meta. bot/workers/inbound-message.worker.js later runs handleWebhookPost on
 * the envelope, so dedup, the inbound limits and the reaction all still happen
 * there, in that order.
 *
 * WhatsApp only: Slack already acks before it dispatches, and its modals need
 * the live trigger_id, so Slack stays in-process (createSlackRouter in
 * whatsapp-bot.js).
 */

const express = require('express');
const { createWhatsAppRouter } = require('./adapters/whatsapp');
const { IngressDispatcher } = require('./ingress-dispatcher');
const { whatsAppRequestToEnvelope } = require('./envelope');
const { getCurrentCorrelationId, generateCorrelationId } = require('../shared/utils/structured-logger');
const { logToFile } = require('../shared/utils/logger');

/**
 * An IngressDispatcher whose every envelope becomes an `inbound_message` job.
 *
 * @param {Object} [queueService] - Queue driver (defaults to the QUEUE_DRIVER index)
 * @returns {IngressDispatcher}
 */
function createQueueingDispatcher(queueService = require('../shared/services/queue')) {
  const dispatcher = new IngressDispatcher();
  dispatcher.setQueueProducer((envelope) => queueService.queueJob(
    envelope.from || envelope.id,
    'inbound_message',
    envelope,
    { deduplicationId: envelope.id }
  ));
  return dispatcher;
}

/**
 * A `dispatch` for createWhatsAppRouter that hands each request to `dispatcher`
 * as an envelope instead of running handleWebhookPost.
 *
 * @param {IngressDispatcher} [dispatcher]
 * @returns {Function} async (req, res) => void
 */
function createQueueDispatch(dispatcher = createQueueingDispatcher()) {
  return async function queueDispatch(req, res) {
    const envelope = whatsAppRequestToEnvelope(req, getCurrentCorrelationId() || generateCorrelationId());
    if (!envelope) return;

    try {
      await dispatcher.dispatch(envelope, { req, res });
    } catch (error) {
      logToFile('❌ Gateway could not queue inbound message', { error: error.message, envelopeId: envelope.id });
      // Not a 200: Meta re-delivers a webhook it gets no 200 for, so the
      // message is retried rather than lost.
      if (!res.headersSent) res.status(500).send('QUEUE_ERROR');
    }
  };
}

/**
 * Router serving /webhook through `dispatcher` (used by the standalone server).
 *
 * @param {IngressDispatcher} [dispatcher]
 * @returns {express.Router}
 */
function createWebhookRoutes(dispatcher = createQueueingDispatcher()) {
  const router = express.Router();
  router.use('/webhook', createWhatsAppRouter({
    dispatch: createQueueDispatch(dispatcher),
    encapsulateIngress: false,
  }));
  return router;
}

module.exports = {
  createWebhookRoutes,
  createQueueDispatch,
  createQueueingDispatcher,
};
