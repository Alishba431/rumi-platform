/**
 * Canonical Inbound Message Envelope
 *
 * Normalizes vendor-specific webhook payloads (WhatsApp Meta, Slack, Baileys, etc.)
 * into a single channel-agnostic data structure.
 */

/**
 * Standard event/message types supported across channels.
 */
const ENVELOPE_TYPES = {
  TEXT: 'text',
  INTERACTIVE_BUTTON: 'interactive_button',
  INTERACTIVE_LIST: 'interactive_list',
  INTERACTIVE_FLOW: 'interactive_flow',
  AUDIO: 'audio',
  VOICE: 'voice',
  IMAGE: 'image',
  DOCUMENT: 'document',
  STATUS_UPDATE: 'status_update',
  SYSTEM: 'system',
  UNKNOWN: 'unknown'
};

/**
 * Factory to create a standardized InboundMessageEnvelope.
 *
 * @param {Object} options
 * @param {string} options.id - Unique message or event identifier
 * @param {string} options.channel - Ingress channel name ('whatsapp', 'slack', etc.)
 * @param {string} options.from - Normalized sender identifier
 * @param {number} [options.timestamp] - Unix epoch timestamp (seconds)
 * @param {string} options.type - One of ENVELOPE_TYPES
 * @param {Object} [options.payload] - Channel-agnostic message payload
 * @param {Object} [options.metadata] - Routing and telemetry metadata
 * @param {any} [options.rawBody] - Original wire payload for legacy compatibility
 * @returns {Object} Normalized InboundMessageEnvelope
 */
function createInboundEnvelope({
  id,
  channel,
  from,
  timestamp = Math.floor(Date.now() / 1000),
  type = ENVELOPE_TYPES.UNKNOWN,
  payload = {},
  metadata = {},
  rawBody = null
}) {
  const safeMetadata = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    id: String(id || `evt_${Date.now()}`),
    channel: String(channel || 'unknown'),
    from: String(from || ''),
    timestamp: typeof timestamp === 'number' ? timestamp : Math.floor(Date.now() / 1000),
    type,
    payload: payload && typeof payload === 'object' ? { ...payload } : {},
    metadata: {
      correlationId: safeMetadata.correlationId || null,
      phoneNumberId: safeMetadata.phoneNumberId || null,
      ...safeMetadata
    },
    rawBody
  };
}

/**
 * Normalizes a WhatsApp (Meta) webhook request into an InboundMessageEnvelope.
 * The original body rides along as rawBody, so the worker can hand
 * handleWebhookPost exactly what Meta sent.
 *
 * @param {Object} req - Express request
 * @param {string} correlationId - Tracing identifier
 * @returns {Object|null} InboundMessageEnvelope or null if unparseable
 */
function whatsAppRequestToEnvelope(req, correlationId) {
  // Lazy: keeps createInboundEnvelope free of bot dependencies.
  const validators = require('../shared/utils/validators');

  const statusValidation = validators.validateWebhookStatus(req);
  if (statusValidation && statusValidation.statuses) {
    const primaryStatus = statusValidation.statuses[0] || {};
    return createInboundEnvelope({
      id: primaryStatus.id || `status_${Date.now()}`,
      channel: 'whatsapp',
      from: primaryStatus.recipient_id || '',
      timestamp: primaryStatus.timestamp ? parseInt(primaryStatus.timestamp, 10) : Math.floor(Date.now() / 1000),
      type: ENVELOPE_TYPES.STATUS_UPDATE,
      payload: {
        status: primaryStatus.status,
        statuses: statusValidation.statuses,
        errors: primaryStatus.errors || null
      },
      metadata: {
        correlationId,
        rawEntry: req.body?.entry?.[0]
      },
      rawBody: req.body
    });
  }

  const validation = validators.validateWebhookMessage(req);
  if (!validation) {
    return null;
  }

  const { entry, message, from, messageBody, messageType, messageTimestamp, phoneNumberId } = validation;

  let envelopeType = ENVELOPE_TYPES.UNKNOWN;
  const payload = {
    messageBody
  };

  if (messageType === 'text') {
    envelopeType = ENVELOPE_TYPES.TEXT;
    payload.text = messageBody;
  } else if (messageType === 'interactive' && message.interactive?.type === 'button_reply') {
    if (message.interactive?.button_reply?.id) {
      envelopeType = ENVELOPE_TYPES.INTERACTIVE_BUTTON;
      payload.actionId = message.interactive.button_reply.id;
      payload.text = message.interactive.button_reply.title;
    }
  } else if (messageType === 'interactive' && message.interactive?.type === 'list_reply') {
    if (message.interactive?.list_reply?.id) {
      envelopeType = ENVELOPE_TYPES.INTERACTIVE_LIST;
      payload.actionId = message.interactive.list_reply.id;
      payload.text = message.interactive.list_reply.title;
    }
  } else if (messageType === 'interactive' && message.interactive?.type === 'nfm_reply') {
    envelopeType = ENVELOPE_TYPES.INTERACTIVE_FLOW;
    payload.flowName = message.interactive.nfm_reply.name;
    try {
      payload.flowData = JSON.parse(message.interactive.nfm_reply.response_json || '{}');
    } catch (e) {
      payload.flowData = {};
    }
  } else if (messageType === 'audio') {
    envelopeType = ENVELOPE_TYPES.AUDIO;
    payload.mediaId = message.audio?.id;
    payload.mimeType = message.audio?.mime_type;
  } else if (messageType === 'voice') {
    envelopeType = ENVELOPE_TYPES.VOICE;
    payload.mediaId = message.voice?.id;
    payload.mimeType = message.voice?.mime_type;
  } else if (messageType === 'image') {
    envelopeType = ENVELOPE_TYPES.IMAGE;
    payload.mediaId = message.image?.id;
    payload.caption = message.image?.caption;
    payload.mimeType = message.image?.mime_type;
  } else if (messageType === 'document') {
    envelopeType = ENVELOPE_TYPES.DOCUMENT;
    payload.mediaId = message.document?.id;
    payload.filename = message.document?.filename;
    payload.mimeType = message.document?.mime_type;
  }

  return createInboundEnvelope({
    id: message.id,
    channel: 'whatsapp',
    from,
    timestamp: messageTimestamp,
    type: envelopeType,
    payload,
    metadata: {
      correlationId,
      phoneNumberId,
      rawEntry: entry,
      messageType,
      fullMessage: message
    },
    rawBody: req.body
  });
}

module.exports = {
  ENVELOPE_TYPES,
  createInboundEnvelope,
  whatsAppRequestToEnvelope
};
