/**
 * none-channel.service — the WhatsApp-family "driver" for CHANNEL_DRIVER=none:
 * a deployment with no WhatsApp at all, answering only on its additive
 * channels (Matrix, Slack, Discord). The router sends every prefixed
 * identifier ("mtx:…", "slack:…") to those drivers; only a bare phone number
 * reaches this file, and there is nowhere to send it, so every send fails
 * loudly instead of pretending to succeed.
 *
 * The method list is the same 30 methods meta-channel.service.js declares
 * (tests/messaging/channel-driver-parity.test.js checks it). The two pure
 * helpers keep working, since callers use them for any channel's text.
 */

const SEND_METHODS = [
  'sendMessage', 'sendTextReturningId', 'sendAudioFromUrlReturningId', 'sendReaction', 'showTypingIndicator',
  'startContinuousTypingIndicator', 'getMediaInfo', 'downloadMedia', 'sendDocument', 'sendAudio',
  'sendDocumentFromUrl', 'sendAudioFromUrl', 'sendImageFromUrl', 'sendTemplate', 'sendVideo', 'sendVideoFromUrl',
  'sendImage', 'sendSticker', 'sendInteractiveButtons', 'sendImageWithButtons', 'sendInteractiveMessage', 'sendFlow',
  'sendLanguageSelectionList', 'sendStyleCarousel', 'sendStyleListFallback', 'sendFeatureMenuCarousel',
  'sendFeatureMenuListFallback',
];

function noWhatsApp(method, to) {
  return new Error(
    `No WhatsApp channel is configured (CHANNEL_DRIVER=none), so ${method}() cannot reach "${to}". `
    + 'A bare phone number needs CHANNEL_DRIVER=meta or baileys; Matrix/Slack/Discord identities carry their own prefix.'
  );
}

const NoneChannel = {
  _removeEmotionTags(text) {
    return String(text || '').replace(/\[[a-zA-Z\s]+\]\s*/g, '').trim();
  },
  buildStyleCarouselPayload() {
    return null;
  },
  buildFeatureMenuCarouselPayload() {
    return null;
  },
};

for (const method of SEND_METHODS) {
  NoneChannel[method] = method === 'startContinuousTypingIndicator'
    ? (to) => { throw noWhatsApp(method, to); }
    : async (to) => { throw noWhatsApp(method, to); };
}

module.exports = NoneChannel;
