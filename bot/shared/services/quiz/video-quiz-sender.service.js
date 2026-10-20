'use strict';
/**
 * Execute the render contract against the WhatsApp API.
 *
 * VideoQuizRenderService decides WHAT is sent and in what order. This file is
 * the only place that turns those instructions into API calls. Keeping them
 * apart is what makes the ordering testable without a phone, and what let the
 * review tooling check that the shipped sequence is the one that was reviewed.
 *
 * Three things here are load-bearing, each verified against
 * whatsapp.service.js rather than assumed:
 *
 *  - ANCHORING (R4). An option label is a quoted reply to the clip it names.
 *    The ordinary send helpers return booleans, so this uses the two
 *    *ReturningId variants — you cannot quote a message whose id you threw away.
 *  - IMAGE + BUTTONS. sendInteractiveButtons ignores any header, so a picture
 *    question with <=3 options must go through sendImageWithButtons. Passing a
 *    headerImage to the former would have silently dropped the picture.
 *  - PACING. Messages are spaced. WhatsApp does not guarantee ordering for
 *    rapid-fire sends, and an out-of-order stimulus clip is the R18 bug again,
 *    this time caused by the wire rather than the data.
 *  - THE COUNTER IS NOT A MESSAGE. "Question n of N" is prepended to the body
 *    or caption of the message that carries it (`m.counter`, set by
 *    render.build), never sent on its own. It cost a whole send off the
 *    recipient's 5-minute window for eleven characters of chrome, and that
 *    send is what tipped an 8-question quiz over the budget and stalled it for
 *    minutes at a time.
 */

const WhatsAppService = require('../whatsapp.service');
const { logToFile } = require('../../utils/logger');
const { logEvent } = require('../../utils/structured-logger');
const render = require('./video-quiz-render.service');
// Every send in this file spends the recipient's Meta per-pair budget, so
// every send waits on the proactive throttle first (the per-recipient rule; this
// port had it only on the two "side door" sends in video-quiz.service).
const rateLimiter = require('./video-quiz-rate-limiter.service');
const { resolveUx } = require('../../config/ux-strings');
const { truncateCodePoints } = require('./religious-marks');
const { answersByTyping } = require('./quiz-channel');

// Enough for WhatsApp to preserve order without making a child wait.
const GAP_TEXT_MS = 700;
const GAP_MEDIA_MS = 1200;

/** Picker chrome in the quiz language ('en' when the context carries none). */
const chrome = (key, ctx, params) => resolveUx(key, { language: ctx && ctx.language, params });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fold "Question n of N" into a body or caption that was going out anyway.
 *
 * `m.counter` is `{ i, n }` and is set by render.build() on exactly ONE message
 * per question — the first thing the child reads. Everything else is unchanged,
 * so a message with no counter renders exactly as it did before.
 */
function withCounter(m, body, ctx) {
  if (!m || !m.counter) return body;
  const line = chrome('vqQuestionOf', ctx, { i: m.counter.i, n: m.counter.n });
  return body ? `${line}\n\n${body}` : line;
}

/**
 * Build list rows that a child can actually read.
 *
 * Meta caps a row TITLE at 24 characters and truncates SILENTLY — a reviewer
 * received "5 red pencils and 10 blu" and "23 blue pencils, and 19" as things
 * to choose between. Rows also carry a DESCRIPTION (72 chars), which is where
 * the option belongs once it outgrows the title.
 *
 * Putting it there was right; KEEPING the cut-off title above it was
 * not. A child read "The flow of free electro" and then, underneath,
 * "The flow of free electrons" — the same sentence twice, the first copy
 * broken mid-word. When an option cannot fit its title, the title becomes a
 * plain letter handle and the description carries the whole option.
 *
 * The handle is all-or-nothing across the list. A list mixing real labels with
 * bare letters reads as a rendering fault, and the letters line up with
 * askBody()'s lettering on the questions long enough to still need it.
 */
function listRows(options, ctx, optionIndices, letterTitles = false) {
  const shown = options.slice(0, 10);
  // Display position is NOT the option's identity. The id must carry
  // the ORIGINAL index or every shuffled question mis-scores.
  const idx = optionIndices || shown.map((_, i) => i);
  // A QUESTION CARD already draws each option behind its letter, so its rows are
  // letters whatever their length — the same rule the letter buttons follow.
  const handled = letterTitles || shown.some((t) => [...t].length > render.LIST_ROW_TITLE_MAX);
  return shown.map((title, i) => {
    const row = {
      id: render.answerId(ctx.questionId, idx[i]),
      title: handled ? render.optionLetter(i) : title,
    };
    if (handled) {
      // Code-point cap, and never a cut that strands a sacred name from its
      // honorific (an Islamiyat option ending "…نبی کریم" with the ﷺ dropped).
      row.description = truncateCodePoints(title, render.LIST_ROW_DESCRIPTION_MAX);
    }
    return row;
  });
}

/**
 * Send one phase of a question.
 *
 * @param {string} phone
 * @param {Array}  msgs   output of render.build()
 * @param {string} phase  'question' | 'interaction' | 'answer'
 * @param {Object} ctx    { questionId, sessionId, flowId, isCorrect, selectedIndex }
 * @returns {Promise<{sent:number, failed:number}>}
 */
async function sendPhase(phone, msgs, phase, ctx = {}) {
  // A prior review round closed this phase's latency at "slow from the
  // driver's side" with no way to say where the time actually went. `ms`
  // decomposes into where the time actually went:
  // `msSending` (the WhatsApp calls themselves), `msThrottled` (waiting on
  // rateLimiter.throttle), `msGaps` (our own deliberate GAP_TEXT_MS/
  // GAP_MEDIA_MS pacing below) — so a slow phase can be pinned on Meta, our
  // throttle, or our own pacing instead of guessed at.
  const phaseStart = Date.now();
  let sent = 0;
  let failed = 0;
  let lastMessageId = null;
  let messages = 0;
  let msSending = 0;
  let msThrottled = 0;
  let msGaps = 0;
  const kinds = [];

  const emitPhaseSent = (pickerFailed) => {
    logEvent('video_quiz.phase_sent', {
      phase, sessionId: ctx.sessionId, questionId: ctx.questionId,
      messages, sent, failed, pickerFailed,
      ms: Date.now() - phaseStart, msSending, msThrottled, msGaps, kinds,
    });
  };

  for (const m of msgs.filter((x) => x.phase === phase)) {
    // The ANSWER phase carries the correct branch plus one branch per wrong
    // option. Send only the branch matching what the child actually picked.
    if (phase === 'answer') {
      if (m.role === 'feedback_correct' && !ctx.isCorrect) continue;
      if (m.role === 'feedback_incorrect') {
        if (ctx.isCorrect) continue;
        if (m.optionIndex !== undefined && m.optionIndex !== ctx.selectedIndex) continue;
      }
    }
    messages += 1;
    kinds.push(m.kind);
    // The tap surface becomes lettered text where the child answers by typing
    // (Baileys, Matrix) — see sendLetteredAsk — and only when the quiz reads a
    // typed letter (ctx.typedAnswers: a lesson quiz, the lesson quiz on).
    const typed = (m.role === 'ask' || m.role === 'picture_flow')
      && ctx.typedAnswers === true && answersByTyping(phone);

    let ok = false;
    try {
      const throttleStart = Date.now();
      await rateLimiter.throttle(phone);
      msThrottled += Date.now() - throttleStart;

      const sendStart = Date.now();
      switch (m.kind) {
        case 'text': {
          const text = withCounter(m, m.body, ctx);
          if (m.anchoredToPrevious && lastMessageId) {
            const id = await WhatsAppService.sendTextReturningId(
              phone, text, { contextMessageId: lastMessageId }
            );
            ok = !!id;
          } else {
            ok = await WhatsAppService.sendMessage(phone, text);
          }
          break;
        }
        case 'audio': {
          // Option clips need an id so their label can quote them; other clips
          // do not, but one code path is cheaper to reason about than two.
          const id = await WhatsAppService.sendAudioFromUrlReturningId(phone, m.url);
          if (id) lastMessageId = id;
          ok = !!id;
          break;
        }
        case 'image':
          ok = await WhatsAppService.sendImageFromUrl(phone, m.url, withCounter(m, m.caption || '', ctx));
          break;
        case 'buttons':
          ok = typed ? await sendLetteredAsk(phone, m, ctx) : await sendButtons(phone, m, ctx);
          break;
        case 'list':
          ok = typed ? await sendLetteredAsk(phone, m, ctx) : await WhatsAppService.sendInteractiveMessage(phone, {
            body: {
              text: withCounter(m,
                m.letterTitles ? cardAskBody(m, ctx, m.options.length) : m.body, ctx),
            },
            action: {
              button: chrome('vqChooseAnswer', ctx),
              sections: [{
                title: chrome('vqOptions', ctx),
                rows: listRows(m.options, ctx, m.optionIndices, m.letterTitles),
              }],
            },
          });
          break;
        case 'flow':
          ok = typed ? await sendLetteredAsk(phone, m, ctx) : await sendPictureFlow(phone, m, ctx);
          break;
        case 'multiflow':
          // A set has no tap surface on any channel this release sends to:
          // reply buttons and list rows are single-select. Every channel gets
          // the lettered text and "reply with every right letter".
          ok = await sendLetteredAsk(phone, m, ctx, { multi: true });
          break;
        default:
          logToFile('⚠️ video-quiz: unknown message kind', { kind: m.kind });
      }
      msSending += Date.now() - sendStart;
    } catch (err) {
      logToFile('❌ video-quiz send threw', {
        phone: phone.slice(-4), role: m.role, kind: m.kind, error: err.message,
      });
      ok = false;
    }

    if (ok) {
      sent += 1;
    } else {
      failed += 1;
      logToFile('⚠️ video-quiz message not delivered', {
        phone: phone.slice(-4), role: m.role, kind: m.kind,
      });
      // A dropped clip degrades the question; a dropped PICKER strands the
      // child with nothing to tap. Only the latter aborts the phase.
      if (m.role === 'ask' || m.role === 'picture_flow') {
        emitPhaseSent(true);
        return { sent, failed, pickerFailed: true };
      }
    }
    const gapStart = Date.now();
    await sleep(m.kind === 'text' ? GAP_TEXT_MS : GAP_MEDIA_MS);
    msGaps += Date.now() - gapStart;
  }
  emitPhaseSent(false);
  return { sent, failed, pickerFailed: false };
}

/**
 * The body under a QUESTION CARD, naming exactly the letters THIS send offers.
 *
 * It was hardcoded to "A, B or C" whatever the card held, so a two-option card
 * told the child to tap a C that was never sent. `count` is what
 * the picker will actually emit — three for a button row, up to ten for a list.
 */
function cardAskBody(m, ctx, count) {
  const letters = render.letterListLabel(count, {
    separator: chrome('vqLetterSep', ctx),
    conjunction: chrome('vqLetterOr', ctx),
  });
  return chrome('vqCardAsk', ctx, { letters });
}

/**
 * <=3 options. sendInteractiveButtons has NO header support, so a question
 * image has to go through sendImageWithButtons instead — verified in
 * whatsapp.service.js, not assumed from the Meta docs.
 */
async function sendButtons(phone, m, ctx) {
  const bIdx = m.optionIndices || m.options.map((_, i) => i);
  const shown = m.options.slice(0, 3);
  const buttons = shown.map((title, i) => ({
    id: render.answerId(ctx.questionId, bIdx[i]),
    // A question card carries the options in the picture; the buttons are letters.
    title: m.letterTitles ? render.optionLetter(i) : truncateCodePoints(title, render.BUTTON_TITLE_MAX),
  }));
  const body = withCounter(m, m.letterTitles ? cardAskBody(m, ctx, shown.length) : m.body, ctx);
  if (m.headerImage) {
    // A QUESTION CARD reaches here too (render.build attaches the card as this
    // message's header when the picker is buttons), so the picture, the
    // counter, the "tap A, B or C" cue and the letters are one send. This is
    // also the cheaper call on a re-send: it caches Meta's media id for the
    // uploaded picture for 25 days, which sendImageFromUrl does not.
    return WhatsAppService.sendImageWithButtons(phone, m.headerImage, body, buttons);
  }
  return WhatsAppService.sendInteractiveButtons(phone, { body, buttons });
}

/**
 * R8/R15 — picture options as tappable pictures inside a Flow.
 *
 * Uses the hybrid Flow send: `navigateData` + `screen` pre-fills the option images
 * on the first screen while the Flow's own data_api_version keeps the submit on
 * data_exchange, so the tap comes back to us for grading.
 *
 * Falls back to the numbered picker whenever the Flow cannot be built — a child
 * must never be left looking at a grid with nothing to tap.
 */
async function sendPictureFlow(phone, m, ctx) {
  const flowId = ctx.flowId || process.env.VIDEO_QUIZ_FLOW_ID;
  const images = m.optionImages || [];
  // EVERY option must carry an image. A Flow with some pictures missing is
  // worse than the numbered picker: the child compares a photo against a blank.
  const complete = images.length === (m.options || []).length && images.every(Boolean);
  if (flowId && complete) {
    const ok = await WhatsAppService.sendFlow(phone, {
      flowId,
      buttonText: 'Tap the picture',
      body: withCounter(m, m.body, ctx),
      screen: 'ASK',
      flowToken: `vq:${ctx.sessionId || 'none'}:${ctx.questionId}`,
      navigateData: {
        question: m.body,
        options: m.options.map((title, i) => ({
          id: String((m.optionIndices || m.options.map((_, k) => k))[i]),
          title, image: images[i] || '', 'alt-text': title,
        })),
      },
    });
    if (ok) return true;
    logToFile('⚠️ picture Flow failed — falling back to numbered picker', {
      phone: phone.slice(-4), questionId: ctx.questionId,
    });
  }
  return WhatsAppService.sendInteractiveMessage(phone, {
    body: { text: withCounter(m, 'Which picture is right?', ctx) },
    action: {
      button: chrome('vqChooseAnswer', ctx),
      sections: [{ title: chrome('vqOptions', ctx), rows: listRows(m.options, ctx, m.optionIndices) }],
    },
  });
}

/**
 * A question as LETTERED TEXT, answered by typing the letter.
 *
 * On Baileys and Matrix a reply button or list is drawn as numbered text and
 * the menu matcher (messaging/pending-options.js) refuses a one-letter reply,
 * so a child who types the "B" they can see would get nothing back. Here the
 * question itself carries the letters — "A. Square / B. Triangle / C. Circle"
 * and "Reply with A, B or C." — and video-quiz.service answerTypedLetter reads
 * the letter (or its number) as the answer.
 *
 * A select-all question (`multi`) is sent this way on EVERY channel: buttons
 * and list rows are single-select, so "reply with every right letter" is the
 * only surface that can take a set. The set is scored by exact equality.
 *
 * The picture that would have been the picker's header (a question card, a
 * question image) goes first as its own image: a text message has no header.
 * A question card already draws each option behind its letter, so the text
 * then names only the letters.
 */
function letteredAskText(m, ctx, { multi = false } = {}) {
  const options = m.options || [];
  const letters = render.letterListLabel(options.length, {
    separator: chrome('vqLetterSep', ctx),
    conjunction: chrome('vqLetterOr', ctx),
  });
  const prompt = m.stem !== undefined ? m.stem : m.body;
  const lines = m.letterTitles ? '' : options.map((l, i) => `${render.optionLetter(i)}. ${l}`).join('\n');
  const cue = multi ? chrome('vqMultiTypeAsk', ctx) : chrome('vqTypedAsk', ctx, { letters });
  return withCounter(m, [prompt, lines, cue].filter(Boolean).join('\n\n'), ctx);
}

async function sendLetteredAsk(phone, m, ctx, opts = {}) {
  if (m.headerImage) {
    const pic = await WhatsAppService.sendImageFromUrl(phone, m.headerImage, '');
    // Without the picture the question cannot be answered: report the ask as
    // not delivered so the question is retried, not left half-asked.
    if (!pic) return false;
  }
  return WhatsAppService.sendMessage(phone, letteredAskText(m, ctx, opts));
}

module.exports = { sendPhase, listRows, letteredAskText, GAP_TEXT_MS, GAP_MEDIA_MS };
