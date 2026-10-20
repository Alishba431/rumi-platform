'use strict';
/**
 * The child's score card: a rendered image of how they did, sent at the end of
 * the quiz with the result sentence as its caption.
 *
 * Best-effort throughout, same contract as the rest of finish()'s
 * post-completion side effects (notifyInviter, offerInvite, offerShare): a
 * render or send failure must never cost the child their result. On any
 * failure this returns false and finish() sends the plain-text result instead,
 * so "nothing" is never a possible outcome.
 *
 * HOW A RENDERED PICTURE IS SENT. The card is rendered in memory, and the
 * channel-driver contract (meta-channel.service.js statics, which every driver
 * implements) has no "send these bytes" call — only `sendImage(to, path,
 * caption)`. So the PNG is written to a temporary file, sent from there, and the
 * file removed (sendPngImage below — the class card uses the same helper).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
// This send is not routed through video-quiz-sender.service.js's sendPhase(),
// so it throttles itself (see sendScorecard below). It's the last message a
// completing quiz sends to the phone, so it lands right on top of an
// already-near-full window from the questions that preceded it.
const rateLimiter = require('./video-quiz-rate-limiter.service');
const { resolveUx } = require('../../config/ux-strings');

const TIER_KEY = {
  mastered: 'vqTierMastered',
  developing: 'vqTierDeveloping',
  needs_practice: 'vqTierNeedsPractice',
};

function tierFor(pct) {
  return pct >= 80 ? 'mastered' : pct >= 60 ? 'developing' : 'needs_practice';
}

/**
 * The caption, in the QUIZ language (an Urdu quiz ends in Urdu). The star
 * sentence is chosen by count, whole: Urdu agrees the noun AND the verb with
 * one star (آپ کو 1 ستارہ ملا!) against several (آپ کو 3 ستارے ملے!).
 */
function buildCaption({ correct, total, pct, stars, language = 'en' }) {
  const starsLine = resolveUx(Number(stars) === 1 ? 'vqStarsEarnedOne' : 'vqStarsEarned', {
    language, params: { stars },
  });
  return resolveUx('vqScoreCaption', {
    language,
    params: {
      correct, total, pct, starsLine,
      tier: resolveUx(TIER_KEY[tierFor(pct)], { language }),
    },
  });
}

/** Pure render step — a PNG buffer, or null on failure. Testable without WhatsApp. */
async function renderScorecardImage({ topic, correct, total, pct, subject, takerName, language = 'en' }) {
  try {
    const renderHtml = require('../../templates/video-quiz-scorecard.template');
    const { htmlToImage } = require('../../utils/html-to-pdf');
    // `language` is the QUIZ's — a child reads their card in whatever language
    // they just answered in, and their name has to render in its own script.
    const html = renderHtml({ topic, correct, total, pct, subject, takerName, language });
    const png = await htmlToImage(html, { width: 540, deviceScaleFactor: 2, selector: '.card', untrusted: true });
    return png || null;
  } catch (err) {
    logToFile('⚠️ video-quiz: scorecard render failed', { error: err.message });
    return null;
  }
}

/**
 * Send a PNG held in memory as an image message: write it to a temporary file,
 * `sendImage` it, remove the file whatever happened. The drivers read the file
 * before they resolve, so clearing it afterwards is safe; leaving these behind
 * would fill a worker's disk over weeks.
 *
 * @returns {Promise<boolean>} what the driver reported
 */
async function sendPngImage(to, png, caption, { prefix = 'quiz-card' } = {}) {
  const file = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`);
  try {
    fs.writeFileSync(file, png);
    return Boolean(await WhatsAppService.sendImage(to, file, caption));
  } finally {
    try { fs.unlinkSync(file); } catch { /* a stray temp file is not worth failing the send over */ }
  }
}

/**
 * Render and send the scorecard. Returns true if the image sent, false if it
 * fell back (caller is expected to have already sent, or to send, the plain
 * text version — see finish() in video-quiz.service.js).
 */
async function sendScorecard(phone, { topic, correct, total, pct, subject, takerName, language = 'en' }) {
  const { starsAndBadge } = require('../../templates/video-quiz-scorecard.template');
  const { stars } = starsAndBadge(pct, language);
  const caption = buildCaption({ correct, total, pct, stars, language });

  const png = await renderScorecardImage({ topic, correct, total, pct, subject, takerName, language });
  if (!png) return false;

  try {
    await rateLimiter.throttle(phone);
    return await sendPngImage(phone, png, caption, { prefix: 'scorecard' });
  } catch (err) {
    logToFile('⚠️ video-quiz: scorecard send failed', { error: err.message });
    return false;
  }
}

module.exports = { renderScorecardImage, sendScorecard, sendPngImage, buildCaption, tierFor };
